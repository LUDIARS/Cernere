/**
 * 承認待ちのパスキー (spec/plan/2026-10-14-passkey-only-authentication.md §4 / §5)。
 *
 * 端末追加 (pairing) とリカバリー QR の新しいキーは、UV 済みで登録できても、元端末の承認や
 * 回復待機が済むまではログインにも action proof にも使わせない。passkeys に入れると
 * revoked_at IS NULL の全判定が通ってしまうため、別表に置き、確定時に passkeys へ移す。
 */

import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { RegistrationResponseJSON, VerifiedRegistrationResponse } from "@simplewebauthn/server";

import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";

export type CandidatePurpose = "pairing" | "recovery";

type Database = Pick<typeof db, "select" | "insert" | "update">;

export interface NewCandidateInput {
  userId: string;
  purpose: CandidatePurpose;
  response: RegistrationResponseJSON;
  registrationInfo: NonNullable<VerifiedRegistrationResponse["registrationInfo"]>;
  nickname?: string | null;
}

/** 検証済みの登録結果を候補として保存し、その id を返す。 */
export async function insertPasskeyCandidate(database: Database, input: NewCandidateInput): Promise<string> {
  const id = crypto.randomUUID();
  const credential = input.registrationInfo.credential;
  await database.insert(schema.passkeyCandidates).values({
    id,
    userId: input.userId,
    purpose: input.purpose,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    deviceType: input.registrationInfo.credentialDeviceType,
    backedUp: input.registrationInfo.credentialBackedUp,
    transports: (input.response.response.transports ?? []) as unknown as Record<string, unknown>[],
    aaguid: input.registrationInfo.aaguid,
    nickname: input.nickname ?? null,
  });
  return id;
}

export type PasskeyCandidate = typeof schema.passkeyCandidates.$inferSelect;

/** 未確定・未失効の候補を行ロック付きで読む。無ければ null。 */
export async function lockOpenCandidate(
  database: Database,
  candidateId: string,
  userId: string,
  purpose: CandidatePurpose,
): Promise<PasskeyCandidate | null> {
  const row = (await database.select().from(schema.passkeyCandidates).where(and(
    eq(schema.passkeyCandidates.id, candidateId),
    eq(schema.passkeyCandidates.userId, userId),
    eq(schema.passkeyCandidates.purpose, purpose),
    isNull(schema.passkeyCandidates.promotedAt),
    isNull(schema.passkeyCandidates.revokedAt),
  )).for("update").limit(1))[0];
  return row ?? null;
}

/**
 * 候補を passkeys へ移して有効化する。呼び出し側のトランザクション内で、
 * 承認・確定の条件を確かめた後に呼ぶ。新しい passkey 行の id を返す。
 */
export async function promotePasskeyCandidate(database: Database, candidate: PasskeyCandidate, now = new Date()): Promise<string> {
  if (candidate.promotedAt || candidate.revokedAt) throw AppError.conflict("Passkey candidate is no longer open");
  const passkeyId = crypto.randomUUID();
  await database.insert(schema.passkeys).values({
    id: passkeyId,
    userId: candidate.userId,
    credentialId: candidate.credentialId,
    publicKey: candidate.publicKey,
    counter: candidate.counter,
    deviceType: candidate.deviceType,
    backedUp: candidate.backedUp,
    transports: candidate.transports as Record<string, unknown>[],
    nickname: candidate.nickname,
    aaguid: candidate.aaguid,
    discoverable: true,
    createdAt: now,
  });
  await database.update(schema.passkeyCandidates).set({ promotedAt: now })
    .where(eq(schema.passkeyCandidates.id, candidate.id));
  return passkeyId;
}

/** 候補を失効させる (拒否・取消・期限切れ・回復の確定で不要になった候補)。 */
export async function revokePasskeyCandidate(database: Database, candidateId: string, now = new Date()): Promise<void> {
  await database.update(schema.passkeyCandidates).set({ revokedAt: now }).where(and(
    eq(schema.passkeyCandidates.id, candidateId),
    isNull(schema.passkeyCandidates.promotedAt),
    isNull(schema.passkeyCandidates.revokedAt),
  ));
}
