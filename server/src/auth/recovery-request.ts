import { verifyAuthenticationResponse, verifyRegistrationResponse } from "./verify-embedded-webauthn.js";
/**
 * リカバリー QR による回復 (SPEC-RECOVERY-QR-USE)。
 *
 * QR を読んで新しいパスキーを作っても、すぐには何も失効させない。回復要求を 24 時間保留し、
 * その間は要求より前からある旧キーの fresh proof で本人が取り消せる。期限後に新しいキー自身の
 * assertion で確定したときだけ、旧キー・全端末・refresh を失効させて新しいキーを有効化する。
 * QR を盗んだ者が即座に本人を締め出せないようにするため。admin は QR では回復できない。
 */

import crypto from "node:crypto";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { redis } from "../redis.js";
import { summarizeUserAgent } from "../lib/user-agent-summary.js";
import { recordSecurityEvent } from "../notify/security-events.js";
import { insertPasskeyCandidate, lockOpenCandidate, promotePasskeyCandidate, revokePasskeyCandidate } from "./passkey-candidates.js";
import { findActiveRecoveryCode, loadRecoveryCodeKey } from "./recovery-code.js";
import {
  CERNERE_ORIGINS,
  CHALLENGE_TTL_SEC,
  REGISTRATION_AUTHENTICATOR_SELECTION,
  RP_ID,
  RP_NAME,
  transportsOf,
} from "./webauthn-policy.js";

/** 回復の待機時間。攻撃者に条件を操作させないよう、例外を作らず常に同じ長さにする。 */
export const RECOVERY_WAIT_MS = 24 * 60 * 60 * 1000;

/** 不一致・使用済み・失効・admin・保留中をすべて同じ応答にする (どれかを区別させない)。 */
const INVALID_CODE = "Recovery code is invalid or can no longer be used";

interface RecoveryCeremony {
  challenge: string;
  userId: string;
  recoveryCodeId: string;
  authEpoch: number;
  recoveryGeneration: number;
}

function ceremonyKey(id: string): string {
  return `passkey:recovery-code:${id}`;
}

function confirmKey(id: string): string {
  return `passkey:recovery-confirm:${id}`;
}

async function hasOpenRequest(userId: string, reader: Pick<typeof db, "select"> = db): Promise<boolean> {
  const row = (await reader.select({ id: schema.recoveryRequests.id }).from(schema.recoveryRequests).where(and(
    eq(schema.recoveryRequests.userId, userId),
    isNull(schema.recoveryRequests.cancelledAt),
    isNull(schema.recoveryRequests.completedAt),
  )).limit(1))[0];
  return Boolean(row);
}

/** QR を照合し、新しいキーの登録 ceremony を始める。 */
export async function beginRecoveryWithCode(code: string): Promise<{
  ceremonyId: string;
  options: Awaited<ReturnType<typeof generateRegistrationOptions>>;
}> {
  const key = loadRecoveryCodeKey();
  const row = await findActiveRecoveryCode(code, key);
  if (!row) throw AppError.unauthorized(INVALID_CODE);
  const user = (await db.select().from(schema.users).where(eq(schema.users.id, row.userId)).limit(1))[0];
  if (!user || user.role === "admin" || row.generation !== user.recoveryGeneration) {
    throw AppError.unauthorized(INVALID_CODE);
  }
  if (await hasOpenRequest(user.id)) await resolveRecoveryConflict(user.id, row.id);

  const label = user.displayName.trim() || `Cernere ${user.id.slice(0, 8)}`;
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: label,
    userDisplayName: label,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    // 手元に残っている旧キーと同じ認証器への重複登録は避けない (失くしたので回復している)。
    excludeCredentials: [],
    authenticatorSelection: REGISTRATION_AUTHENTICATOR_SELECTION,
  });
  const ceremonyId = crypto.randomUUID();
  const ceremony: RecoveryCeremony = {
    challenge: options.challenge,
    userId: user.id,
    recoveryCodeId: row.id,
    authEpoch: user.authEpoch,
    recoveryGeneration: user.recoveryGeneration,
  };
  await redis.set(ceremonyKey(ceremonyId), JSON.stringify(ceremony), "EX", CHALLENGE_TTL_SEC);
  return { ceremonyId, options };
}

/**
 * 保留中の回復があるのに同じコードがもう一度使われた (盗難者と本人が同じ QR を持っている)。
 * どちらにも確定させないよう、保留中の要求・その候補キー・コードをすべて失効させて
 * 運用者の窓口へ回す。先に使った側だけが勝つ (盗難者が本人を締め出す) より安全な側に倒す。
 */
async function resolveRecoveryConflict(userId: string, recoveryCodeId: string): Promise<never> {
  await db.transaction(async (tx) => {
    await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).for("update");
    const open = await tx.select().from(schema.recoveryRequests).where(and(
      eq(schema.recoveryRequests.userId, userId),
      eq(schema.recoveryRequests.recoveryCodeId, recoveryCodeId),
      isNull(schema.recoveryRequests.cancelledAt),
      isNull(schema.recoveryRequests.completedAt),
    )).for("update");
    if (open.length === 0) return;
    const now = new Date();
    for (const request of open) {
      await tx.update(schema.recoveryRequests).set({ cancelledAt: now }).where(eq(schema.recoveryRequests.id, request.id));
      await revokePasskeyCandidate(tx, request.candidateId, now);
    }
    await tx.update(schema.userRecoveryCodes).set({ revokedAt: now }).where(eq(schema.userRecoveryCodes.id, recoveryCodeId));
    await recordSecurityEvent(tx, userId, "recovery.cancelled");
  });
  throw AppError.withCode(409, "recovery_conflict",
    "This recovery code was used twice, so it has been cancelled for safety. Contact an administrator to recover your account.");
}

/** 新しいキーを候補として保存し、回復要求を保留で作る。何も失効させない。 */
export async function finishRecoveryWithCode(input: {
  ceremonyId: string;
  response: RegistrationResponseJSON;
  userAgent?: string;
}): Promise<{ pending: true; eligibleAt: string }> {
  const raw = await redis.getdel(ceremonyKey(input.ceremonyId));
  if (!raw) throw AppError.unauthorized("Recovery expired; scan the QR code again");
  const ceremony = JSON.parse(raw) as RecoveryCeremony;

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

  const now = new Date();
  const eligibleAt = new Date(now.getTime() + RECOVERY_WAIT_MS);
  const device = summarizeUserAgent(input.userAgent);
  await db.transaction(async (tx) => {
    const user = (await tx.select().from(schema.users).where(eq(schema.users.id, ceremony.userId)).for("update"))[0];
    const code = (await tx.select().from(schema.userRecoveryCodes)
      .where(eq(schema.userRecoveryCodes.id, ceremony.recoveryCodeId)).for("update"))[0];
    if (!user || !code || user.role === "admin" || code.userId !== user.id || code.usedAt || code.revokedAt
      || user.authEpoch !== ceremony.authEpoch || user.recoveryGeneration !== ceremony.recoveryGeneration
      || code.generation !== user.recoveryGeneration || await hasOpenRequest(user.id, tx)) {
      // 並行 finish は users の行ロックで直列化されるので、ここに来るのは期限・世代の変化か競合。
      throw AppError.unauthorized(INVALID_CODE);
    }
    const candidateId = await insertPasskeyCandidate(tx, {
      userId: user.id,
      purpose: "recovery",
      response: input.response,
      registrationInfo: verification.registrationInfo!,
      nickname: device,
    });
    await tx.insert(schema.recoveryRequests).values({
      id: crypto.randomUUID(),
      userId: user.id,
      recoveryCodeId: code.id,
      candidateId,
      authEpoch: user.authEpoch,
      recoveryGeneration: user.recoveryGeneration,
      createdAt: now,
      eligibleAt,
    });
    await recordSecurityEvent(tx, user.id, "recovery.requested", { device, eligibleAt: eligibleAt.toISOString() });
  });
  return { pending: true, eligibleAt: eligibleAt.toISOString() };
}

/** 本人に見せる保留中の回復 (取り消し画面用)。 */
export async function getOpenRecoveryRequest(userId: string): Promise<{ requestId: string; createdAt: string; eligibleAt: string; device: string | null } | null> {
  const row = (await db.select({
    id: schema.recoveryRequests.id,
    createdAt: schema.recoveryRequests.createdAt,
    eligibleAt: schema.recoveryRequests.eligibleAt,
    nickname: schema.passkeyCandidates.nickname,
  }).from(schema.recoveryRequests)
    .innerJoin(schema.passkeyCandidates, eq(schema.passkeyCandidates.id, schema.recoveryRequests.candidateId))
    .where(and(
      eq(schema.recoveryRequests.userId, userId),
      isNull(schema.recoveryRequests.cancelledAt),
      isNull(schema.recoveryRequests.completedAt),
    )).limit(1))[0];
  return row ? { requestId: row.id, createdAt: row.createdAt.toISOString(), eligibleAt: row.eligibleAt.toISOString(), device: row.nickname } : null;
}

/**
 * 保留中の回復を取り消す。proof (要求より前からある旧キーによる fresh UV) の検証は
 * 呼び出し側で済ませる。新しい候補キーは passkeys に無いので proof を取れない。
 * 盗まれた可能性のあるコードも失効させ、再発行を促す。
 */
export async function cancelRecoveryRequest(userId: string, requestId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).for("update");
    const request = (await tx.select().from(schema.recoveryRequests).where(and(
      eq(schema.recoveryRequests.id, requestId),
      eq(schema.recoveryRequests.userId, userId),
    )).for("update"))[0];
    if (!request || request.cancelledAt || request.completedAt) throw AppError.conflict("No recovery is pending");
    const now = new Date();
    await tx.update(schema.recoveryRequests).set({ cancelledAt: now }).where(eq(schema.recoveryRequests.id, request.id));
    await revokePasskeyCandidate(tx, request.candidateId, now);
    await tx.update(schema.userRecoveryCodes).set({ revokedAt: now }).where(and(
      eq(schema.userRecoveryCodes.id, request.recoveryCodeId),
      isNull(schema.userRecoveryCodes.usedAt),
    ));
    await recordSecurityEvent(tx, userId, "recovery.cancelled");
  });
}

/** 確定の assertion を始める。候補キーは passkeys に無いので専用の challenge を使う。 */
export async function beginRecoveryConfirmation(): Promise<{
  confirmId: string;
  options: Awaited<ReturnType<typeof generateAuthenticationOptions>>;
}> {
  const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: "required" });
  const confirmId = crypto.randomUUID();
  await redis.set(confirmKey(confirmId), options.challenge, "EX", CHALLENGE_TTL_SEC);
  return { confirmId, options };
}

export interface ConfirmedRecovery {
  user: typeof schema.users.$inferSelect;
  passkeyId: string;
  verifiedAt: number;
}

/**
 * 待機期限を過ぎた回復を、新しいキー自身の assertion で確定する。
 * 旧キー全失効・全端末失効・refresh 削除・epoch と MFA revision の加算・コード使用済み化・
 * 新しいキーの有効化・自己回復の世代更新を 1 トランザクションで行う。
 * 新しいリカバリーコードは返さない (オンボーディングと同じく Cr の画面で発行し直す)。
 */
export async function confirmRecovery(confirmId: string, response: AuthenticationResponseJSON): Promise<ConfirmedRecovery> {
  const challenge = await redis.getdel(confirmKey(confirmId));
  if (!challenge) throw AppError.unauthorized("Challenge expired; try again");
  const candidate = (await db.select().from(schema.passkeyCandidates).where(and(
    eq(schema.passkeyCandidates.credentialId, response.id),
    eq(schema.passkeyCandidates.purpose, "recovery"),
    isNull(schema.passkeyCandidates.promotedAt),
    isNull(schema.passkeyCandidates.revokedAt),
  )).limit(1))[0];
  if (!candidate) throw AppError.unauthorized("No pending recovery for this passkey");

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: CERNERE_ORIGINS,
    expectedRPID: RP_ID,
    credential: {
      id: candidate.credentialId,
      publicKey: new Uint8Array(candidate.publicKey),
      counter: Number(candidate.counter),
      transports: transportsOf(candidate.transports),
    },
    requireUserVerification: true,
  });
  if (!verification.verified) throw AppError.unauthorized("Passkey signature failed");

  const now = new Date();
  return db.transaction(async (tx) => {
    const user = (await tx.select().from(schema.users).where(eq(schema.users.id, candidate.userId)).for("update"))[0];
    const request = (await tx.select().from(schema.recoveryRequests).where(and(
      eq(schema.recoveryRequests.candidateId, candidate.id),
      isNull(schema.recoveryRequests.cancelledAt),
      isNull(schema.recoveryRequests.completedAt),
    )).for("update"))[0];
    if (!user || !request || request.userId !== user.id) throw AppError.unauthorized("No pending recovery for this passkey");
    if (request.frozenAt) throw AppError.forbidden("This recovery is on hold; contact an administrator");
    if (request.eligibleAt.getTime() > now.getTime()) {
      throw AppError.withCode(409, "recovery_waiting", `Recovery completes after ${request.eligibleAt.toISOString()}`);
    }
    const code = (await tx.select().from(schema.userRecoveryCodes)
      .where(eq(schema.userRecoveryCodes.id, request.recoveryCodeId)).for("update"))[0];
    if (user.role === "admin" || user.authEpoch !== request.authEpoch || user.recoveryGeneration !== request.recoveryGeneration
      || !code || code.usedAt || code.revokedAt) {
      throw AppError.unauthorized("Recovery authorization changed; start again");
    }
    const locked = await lockOpenCandidate(tx, candidate.id, user.id, "recovery");
    if (!locked) throw AppError.unauthorized("No pending recovery for this passkey");

    await tx.update(schema.passkeys).set({ revokedAt: now }).where(and(
      eq(schema.passkeys.userId, user.id),
      isNull(schema.passkeys.revokedAt),
    ));
    const passkeyId = await promotePasskeyCandidate(tx, { ...locked, counter: verification.authenticationInfo.newCounter }, now);
    await tx.update(schema.passkeys).set({ lastUsedAt: now }).where(eq(schema.passkeys.id, passkeyId));
    await tx.update(schema.deviceCredentials).set({ revokedAt: now, revokedReason: "recovery" }).where(and(
      eq(schema.deviceCredentials.userId, user.id),
      isNull(schema.deviceCredentials.revokedAt),
    ));
    await tx.delete(schema.refreshSessions).where(eq(schema.refreshSessions.userId, user.id));
    await tx.update(schema.userRecoveryCodes).set({ usedAt: now }).where(eq(schema.userRecoveryCodes.id, code.id));
    await tx.update(schema.recoveryRequests).set({ completedAt: now }).where(eq(schema.recoveryRequests.id, request.id));
    const updated = {
      ...user,
      authEpoch: user.authEpoch + 1,
      mfaRevision: user.mfaRevision + 1,
      recoveryGeneration: user.recoveryGeneration + 1,
      lastLoginAt: now,
    };
    await tx.update(schema.users).set({
      authEpoch: updated.authEpoch,
      mfaRevision: updated.mfaRevision,
      recoveryGeneration: updated.recoveryGeneration,
      lastLoginAt: now,
      updatedAt: now,
    }).where(eq(schema.users.id, user.id));
    await recordSecurityEvent(tx, user.id, "recovery.completed", { device: locked.nickname ?? undefined });
    return { user: updated, passkeyId, verifiedAt: now.getTime() };
  });
}

/** 確定から猶予内か (proof 無しでの初回コード発行に使う)。 */
export async function completedRecoveryWithin(userId: string, withinMs: number): Promise<boolean> {
  const row = (await db.select({ completedAt: schema.recoveryRequests.completedAt }).from(schema.recoveryRequests)
    .where(and(eq(schema.recoveryRequests.userId, userId), isNotNull(schema.recoveryRequests.completedAt)))
    .orderBy(desc(schema.recoveryRequests.completedAt)).limit(1))[0];
  return Boolean(row?.completedAt) && Date.now() - row!.completedAt!.getTime() < withinMs;
}

/**
 * 運用者が保留中の自己回復を凍結する (QR を盗まれた本人が旧キーも持たないとき)。
 * 凍結した要求は確定できない。解除は運用者回復の完了 (invalidateSelfRecovery) で消える。
 */
export async function freezeRecoveryRequest(actorUserId: string, targetUserId: string): Promise<{ frozen: boolean }> {
  return db.transaction(async (tx) => {
    const actor = (await tx.select({ role: schema.users.role }).from(schema.users)
      .where(eq(schema.users.id, actorUserId)).limit(1))[0];
    if (actor?.role !== "admin") throw AppError.forbidden("Administrator required");
    await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, targetUserId)).for("update");
    const rows = await tx.update(schema.recoveryRequests).set({ frozenAt: new Date() }).where(and(
      eq(schema.recoveryRequests.userId, targetUserId),
      isNull(schema.recoveryRequests.cancelledAt),
      isNull(schema.recoveryRequests.completedAt),
      isNull(schema.recoveryRequests.frozenAt),
    )).returning({ id: schema.recoveryRequests.id });
    return { frozen: rows.length > 0 };
  });
}
