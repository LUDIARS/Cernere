import { verifyRegistrationResponse } from "./verify-embedded-webauthn.js";
/**
 * 別端末の追加 (SPEC-DEVICE-PAIRING)。
 *
 * QR を読んだ端末は UV 済みのパスキーを「候補」として登録するだけで、セッションは得ない。
 * 照合番号は QR を読んだ端末にだけ表示し、元端末の利用者がそれを入力して、既存パスキーの
 * fresh action proof で承認したときだけ候補を passkeys へ移す。番号は元端末に出さないので、
 * 自分の端末が手元に無い (QR を盗み見られた) 利用者は承認できない。3 回間違えたら失効する。
 */

import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  generateRegistrationOptions,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { config } from "../config.js";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { redis } from "../redis.js";
import { summarizeUserAgent } from "../lib/user-agent-summary.js";
import { recordSecurityEvent } from "../notify/security-events.js";
import {
  insertPasskeyCandidate,
  lockOpenCandidate,
  promotePasskeyCandidate,
  revokePasskeyCandidate,
} from "./passkey-candidates.js";
import {
  CERNERE_ORIGINS,
  CHALLENGE_TTL_SEC,
  REGISTRATION_AUTHENTICATOR_SELECTION,
  RP_ID,
  RP_NAME,
  transportsOf,
} from "./webauthn-policy.js";

/** QR を出しておく時間。盗み見の機会を減らすため短くする。 */
export const PAIRING_QR_TTL_SEC = 3 * 60;
/** QR を読んでから元端末が承認するまでの猶予。 */
export const PAIRING_APPROVAL_WINDOW_SEC = 10 * 60;

export type PairingState = "waiting" | "candidate" | "approved" | "rejected" | "expired";

export interface PairingStatus {
  pairingId: string;
  state: PairingState;
  candidateLabel?: string;
}

function digestToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

function ceremonyKey(ceremonyId: string): string {
  return `passkey:pairing-ceremony:${ceremonyId}`;
}

/** アカウントの表示 (同意画面用)。名前未設定なら短縮 ID。 */
export function accountLabel(user: { id: string; displayName: string }): string {
  return user.displayName.trim() || `Cernere ${user.id.slice(0, 8)}`;
}

function pairingUrl(token: string): string {
  // token は fragment に載せる (履歴・Referer・プロキシログに残さない)。
  const url = new URL("/device-register", config.frontendUrl);
  url.hash = `t=${token}`;
  return url.toString();
}

/**
 * 元端末で pairing を作る。未使用の前回 pairing は失効させる。
 * 作るだけでは何も付与しないので fresh proof は求めない (承認時に求める)。
 */
export async function createDevicePairing(userId: string): Promise<{ pairingId: string; url: string; expiresIn: number }> {
  const token = crypto.randomBytes(32).toString("base64url");
  const pairingId = crypto.randomUUID();
  const now = new Date();
  await db.transaction(async (tx) => {
    const user = (await tx.select({ authEpoch: schema.users.authEpoch }).from(schema.users)
      .where(eq(schema.users.id, userId)).for("update"))[0];
    if (!user) throw AppError.unauthorized("User not found");
    await tx.update(schema.devicePairings).set({ revokedAt: now }).where(and(
      eq(schema.devicePairings.userId, userId),
      isNull(schema.devicePairings.claimedAt),
      isNull(schema.devicePairings.revokedAt),
    ));
    await tx.insert(schema.devicePairings).values({
      id: pairingId,
      userId,
      tokenDigest: digestToken(token),
      authEpoch: user.authEpoch,
      expiresAt: new Date(now.getTime() + PAIRING_QR_TTL_SEC * 1000),
    });
  });
  return { pairingId, url: pairingUrl(token), expiresIn: PAIRING_QR_TTL_SEC };
}

interface PairingCeremony {
  challenge: string;
  pairingId: string;
  userId: string;
}

/** QR を読んだ端末: token を単回消費して登録 ceremony を始める。 */
export async function beginPairingRegistration(token: string): Promise<{
  ceremonyId: string;
  options: Awaited<ReturnType<typeof generateRegistrationOptions>>;
  account: { label: string };
}> {
  if (!token || token.length > 512) throw AppError.unauthorized("Pairing link is invalid or expired");
  const now = new Date();
  // 同じ token の並行 claim は UPDATE ... WHERE claimed_at IS NULL で 1 件だけ通す。
  const claimed = (await db.update(schema.devicePairings).set({ claimedAt: now }).where(and(
    eq(schema.devicePairings.tokenDigest, digestToken(token)),
    isNull(schema.devicePairings.claimedAt),
    isNull(schema.devicePairings.revokedAt),
  )).returning())[0];
  if (!claimed || claimed.expiresAt.getTime() <= now.getTime()) {
    throw AppError.unauthorized("Pairing link is invalid or expired");
  }

  const user = (await db.select().from(schema.users).where(eq(schema.users.id, claimed.userId)).limit(1))[0];
  if (!user || user.authEpoch !== claimed.authEpoch) throw AppError.unauthorized("Pairing link is invalid or expired");

  const existing = await db.select({
    credentialId: schema.passkeys.credentialId,
    transports: schema.passkeys.transports,
  }).from(schema.passkeys).where(and(eq(schema.passkeys.userId, user.id), isNull(schema.passkeys.revokedAt)));

  const label = accountLabel(user);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: label,
    userDisplayName: label,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: existing.map((e) => ({ id: e.credentialId, transports: transportsOf(e.transports) })),
    authenticatorSelection: REGISTRATION_AUTHENTICATOR_SELECTION,
  });

  const ceremonyId = crypto.randomUUID();
  const ceremony: PairingCeremony = { challenge: options.challenge, pairingId: claimed.id, userId: user.id };
  await redis.set(ceremonyKey(ceremonyId), JSON.stringify(ceremony), "EX", CHALLENGE_TTL_SEC);
  return { ceremonyId, options, account: { label } };
}

/** 照合番号。QR を読んだ端末にだけ表示し、元端末で入力させる。 */
function newMatchCode(): string {
  return String(crypto.randomInt(0, 10_000)).padStart(4, "0");
}

export const PAIRING_MAX_MATCH_ATTEMPTS = 3;

/** QR を読んだ端末: UV 済みのキーを候補として保存し、照合番号を返す。セッションは発行しない。 */
export async function finishPairingRegistration(input: {
  ceremonyId: string;
  response: RegistrationResponseJSON;
  nickname?: string | null;
  userAgent?: string;
}): Promise<{ pairingId: string; matchCode: string }> {
  const raw = await redis.getdel(ceremonyKey(input.ceremonyId));
  if (!raw) throw AppError.unauthorized("Pairing expired; scan a new QR code");
  const ceremony = JSON.parse(raw) as PairingCeremony;

  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: ceremony.challenge,
    expectedOrigin: CERNERE_ORIGINS,
    expectedRPID: RP_ID,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw AppError.unauthorized("Passkey registration failed verification");
  }

  const matchCode = newMatchCode();
  const candidateLabel = summarizeUserAgent(input.userAgent);
  await db.transaction(async (tx) => {
    const user = (await tx.select({ authEpoch: schema.users.authEpoch }).from(schema.users)
      .where(eq(schema.users.id, ceremony.userId)).for("update"))[0];
    const pairing = (await tx.select().from(schema.devicePairings)
      .where(eq(schema.devicePairings.id, ceremony.pairingId)).for("update"))[0];
    if (!user || !pairing || pairing.userId !== ceremony.userId || pairing.authEpoch !== user.authEpoch
      || pairing.candidateId || pairing.revokedAt || pairing.rejectedAt || !pairing.claimedAt
      || pairing.claimedAt.getTime() + PAIRING_APPROVAL_WINDOW_SEC * 1000 <= Date.now()) {
      throw AppError.unauthorized("Pairing expired; scan a new QR code");
    }
    const candidateId = await insertPasskeyCandidate(tx, {
      userId: ceremony.userId,
      purpose: "pairing",
      response: input.response,
      registrationInfo: verification.registrationInfo!,
      nickname: input.nickname ?? candidateLabel,
    });
    await tx.update(schema.devicePairings).set({ candidateId, matchCode, candidateLabel })
      .where(eq(schema.devicePairings.id, pairing.id));
    await recordSecurityEvent(tx, ceremony.userId, "passkey.pairing_requested", { device: candidateLabel });
  });
  return { pairingId: ceremony.pairingId, matchCode };
}

function stateOf(row: typeof schema.devicePairings.$inferSelect, now: number): PairingState {
  if (row.approvedAt) return "approved";
  if (row.rejectedAt) return "rejected";
  if (row.revokedAt) return "expired";
  if (row.candidateId) {
    const deadline = (row.claimedAt?.getTime() ?? 0) + PAIRING_APPROVAL_WINDOW_SEC * 1000;
    return deadline > now ? "candidate" : "expired";
  }
  if (row.claimedAt) return "waiting";
  return row.expiresAt.getTime() > now ? "waiting" : "expired";
}

/** 元端末: 自分の pairing の状態 (候補が来たら照合番号と端末の概略)。 */
export async function getPairingStatus(userId: string, pairingId: string): Promise<PairingStatus> {
  const row = (await db.select().from(schema.devicePairings).where(and(
    eq(schema.devicePairings.id, pairingId),
    eq(schema.devicePairings.userId, userId),
  )).limit(1))[0];
  if (!row) throw AppError.notFound("Pairing not found");
  const state = stateOf(row, Date.now());
  // 照合番号は返さない (元端末の利用者が、追加する端末の画面から読んで入力する)。
  return state === "candidate"
    ? { pairingId, state, candidateLabel: row.candidateLabel ?? undefined }
    : { pairingId, state };
}

/** action proof の resource。承認は pairing と候補の組に束縛する。 */
export function pairingApprovalResource(pairingId: string, candidateId: string): string {
  return `${pairingId}:${candidateId}`;
}

/** 承認対象の候補 id (proof の resource を組み立てるため、元端末に返す)。 */
export async function pairingCandidateId(userId: string, pairingId: string): Promise<string> {
  const row = (await db.select({ candidateId: schema.devicePairings.candidateId }).from(schema.devicePairings).where(and(
    eq(schema.devicePairings.id, pairingId),
    eq(schema.devicePairings.userId, userId),
  )).limit(1))[0];
  if (!row?.candidateId) throw AppError.conflict("No device is waiting for approval");
  return row.candidateId;
}

/**
 * 元端末: 照合番号を確かめた上で承認する。proof の検証は呼び出し側 (HTTP 層) で済ませ、
 * ここでは承認・有効化・消費を 1 トランザクションで行う。
 */
export async function approvePairing(
  userId: string,
  pairingId: string,
  candidateId: string,
  authEpoch: number,
  matchCode: string,
): Promise<void> {
  const mismatch = await db.transaction(async (tx) => {
    const user = (await tx.select({ authEpoch: schema.users.authEpoch }).from(schema.users)
      .where(eq(schema.users.id, userId)).for("update"))[0];
    const pairing = (await tx.select().from(schema.devicePairings)
      .where(eq(schema.devicePairings.id, pairingId)).for("update"))[0];
    if (!user || !pairing || pairing.userId !== userId || user.authEpoch !== authEpoch
      || pairing.authEpoch !== user.authEpoch || pairing.candidateId !== candidateId
      || stateOf(pairing, Date.now()) !== "candidate") {
      throw AppError.conflict("This device can no longer be approved; start again");
    }
    const expected = Buffer.from(pairing.matchCode ?? "");
    const actual = Buffer.from(matchCode);
    if (expected.length === 0 || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      const attempts = pairing.matchAttempts + 1;
      if (attempts >= PAIRING_MAX_MATCH_ATTEMPTS) {
        if (pairing.candidateId) await revokePasskeyCandidate(tx, pairing.candidateId);
        await tx.update(schema.devicePairings).set({ matchAttempts: attempts, rejectedAt: new Date() })
          .where(eq(schema.devicePairings.id, pairingId));
        return "locked" as const;
      }
      await tx.update(schema.devicePairings).set({ matchAttempts: attempts }).where(eq(schema.devicePairings.id, pairingId));
      return "retry" as const;
    }
    const candidate = await lockOpenCandidate(tx, candidateId, userId, "pairing");
    if (!candidate) throw AppError.conflict("This device can no longer be approved; start again");
    await promotePasskeyCandidate(tx, candidate);
    await tx.update(schema.devicePairings).set({ approvedAt: new Date() }).where(eq(schema.devicePairings.id, pairingId));
    await recordSecurityEvent(tx, userId, "passkey.added", { device: pairing.candidateLabel ?? undefined });
    return null;
  });
  // 不一致の記録はコミットしてから伝える (例外で rollback させない)。
  if (mismatch === "locked") throw AppError.withCode(409, "pairing_match_locked", "The number did not match too many times; start again");
  if (mismatch === "retry") throw AppError.withCode(400, "pairing_match_mismatch", "The number does not match the one on the other device");
}

/** 元端末: 心当たりの無い候補を拒否する。何も付与しない操作なので proof は求めない。 */
export async function rejectPairing(userId: string, pairingId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const pairing = (await tx.select().from(schema.devicePairings).where(and(
      eq(schema.devicePairings.id, pairingId),
      eq(schema.devicePairings.userId, userId),
    )).for("update"))[0];
    if (!pairing || pairing.approvedAt) return;
    if (pairing.candidateId) await revokePasskeyCandidate(tx, pairing.candidateId);
    await tx.update(schema.devicePairings).set({ rejectedAt: new Date() }).where(eq(schema.devicePairings.id, pairingId));
  });
}
