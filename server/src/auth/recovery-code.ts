/**
 * リカバリー QR のコード (SPEC-RECOVERY-QR)。
 *
 * 形式は `CRRC1.<recoveryId>.<secret>`。recoveryId は行の特定だけに使う乱数で、userId は載せない。
 * 秘密値は保存せず、DB とは別に管理する鍵の HMAC だけを持つ。QR の秘密値そのものが
 * 回復の資格情報なので、平文は発行応答で一度だけ返し、サーバー側では二度と出さない。
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { revokePasskeyCandidate } from "./passkey-candidates.js";

const CODE_PREFIX = "CRRC1";
const DIGEST_PURPOSE = "cernere-recovery-v1";
const ID_BYTES = 16;
const SECRET_BYTES = 32;
const KEY_BYTES = 32;
const B64URL = /^[A-Za-z0-9_-]+$/;

/** 作成直後・回復確定直後は proof 無しで初回のコードを発行できる (SPEC-PASSKEY-ONBOARDING)。 */
export const RECOVERY_CODE_GRACE_MS = 15 * 60 * 1000;

export interface RecoveryCodeKey {
  keyId: string;
  key: Buffer;
}

/**
 * 鍵は CERNERE_RECOVERY_CODE_KEY (32 byte の base64url) と _KEY_ID。Vault から注入する。
 * 欠けていれば fail-fast し、別の鍵や無鍵ハッシュへ黙って降格しない。
 */
export function loadRecoveryCodeKey(env: NodeJS.ProcessEnv = process.env): RecoveryCodeKey {
  const raw = env.CERNERE_RECOVERY_CODE_KEY;
  const keyId = env.CERNERE_RECOVERY_CODE_KEY_ID;
  if (!raw || !keyId) {
    throw new Error("CERNERE_RECOVERY_CODE_KEY and CERNERE_RECOVERY_CODE_KEY_ID must be set (no fallback).");
  }
  const key = Buffer.from(raw, "base64url");
  if (key.length !== KEY_BYTES) throw new Error(`CERNERE_RECOVERY_CODE_KEY must decode to ${KEY_BYTES} bytes.`);
  return { keyId, key };
}

/** 長さ付きで連結して HMAC を取る (`a||b` の曖昧な連結にしない)。 */
export function digestRecoverySecret(key: Buffer, recoveryId: string, secret: string): string {
  const mac = createHmac("sha256", key);
  for (const part of [DIGEST_PURPOSE, recoveryId, secret]) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    mac.update(length).update(bytes);
  }
  return mac.digest("base64url");
}

export interface ParsedRecoveryCode {
  recoveryId: string;
  secret: string;
}

/** 形式が正しくなければ null (呼び出し側は不一致と同じ応答にする)。 */
export function parseRecoveryCode(code: string): ParsedRecoveryCode | null {
  if (typeof code !== "string" || code.length > 256) return null;
  const parts = code.trim().split(".");
  if (parts.length !== 3 || parts[0] !== CODE_PREFIX) return null;
  const [, recoveryId, secret] = parts;
  if (!B64URL.test(recoveryId) || !B64URL.test(secret)) return null;
  if (Buffer.from(recoveryId, "base64url").length !== ID_BYTES) return null;
  if (Buffer.from(secret, "base64url").length !== SECRET_BYTES) return null;
  return { recoveryId, secret };
}

export function formatRecoveryCode(recoveryId: string, secret: string): string {
  return `${CODE_PREFIX}.${recoveryId}.${secret}`;
}

function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

type Database = Pick<typeof db, "select" | "insert" | "update">;
export type RecoveryCodeRow = typeof schema.userRecoveryCodes.$inferSelect;

/**
 * 有効なコードを照合する。形式不正・不一致・使用済み・失効はすべて null。
 * 照合は定数時間比較だが、DB 参照の時間差まで消えるとは扱わない。
 */
export async function findActiveRecoveryCode(
  code: string,
  key: RecoveryCodeKey,
  reader: Pick<typeof db, "select"> = db,
): Promise<RecoveryCodeRow | null> {
  const parsed = parseRecoveryCode(code);
  if (!parsed) return null;
  const row = (await reader.select().from(schema.userRecoveryCodes).where(and(
    eq(schema.userRecoveryCodes.id, parsed.recoveryId),
    isNull(schema.userRecoveryCodes.revokedAt),
    isNull(schema.userRecoveryCodes.usedAt),
  )).limit(1))[0];
  if (!row || row.keyId !== key.keyId) return null;
  return digestsEqual(row.secretDigest, digestRecoverySecret(key.key, parsed.recoveryId, parsed.secret)) ? row : null;
}

/**
 * 自己回復の資格情報をまとめて無効にする: 有効なコードの失効、保留中の回復要求の取消と
 * その候補キーの失効、世代の加算。再発行・回復確定・運用者回復の全経路から呼ぶ
 * (盗まれた旧 QR で再侵入させない)。users 行のロックは呼び出し側で取る。
 */
export async function invalidateSelfRecovery(database: Database, userId: string, now = new Date()): Promise<void> {
  await database.update(schema.userRecoveryCodes).set({ revokedAt: now }).where(and(
    eq(schema.userRecoveryCodes.userId, userId),
    isNull(schema.userRecoveryCodes.revokedAt),
    isNull(schema.userRecoveryCodes.usedAt),
  ));
  const open = await database.select({ id: schema.recoveryRequests.id, candidateId: schema.recoveryRequests.candidateId })
    .from(schema.recoveryRequests).where(and(
      eq(schema.recoveryRequests.userId, userId),
      isNull(schema.recoveryRequests.cancelledAt),
      isNull(schema.recoveryRequests.completedAt),
    ));
  for (const request of open) {
    await database.update(schema.recoveryRequests).set({ cancelledAt: now }).where(eq(schema.recoveryRequests.id, request.id));
    await revokePasskeyCandidate(database, request.candidateId, now);
  }
  // 読んでから書かず、DB 上で 1 進める (呼び出し側が行ロックを取っていない経路でも取りこぼさない)。
  await database.update(schema.users).set({ recoveryGeneration: sql`${schema.users.recoveryGeneration} + 1` })
    .where(eq(schema.users.id, userId));
}

/**
 * 新しいコードを発行し、平文を返す。既存のコードと保留中の回復はすべて無効にする。
 * users 行のロックは呼び出し側で取る。
 */
export async function issueRecoveryCode(
  database: Database,
  userId: string,
  key: RecoveryCodeKey,
  now = new Date(),
): Promise<{ code: string; issuedAt: string }> {
  await invalidateSelfRecovery(database, userId, now);
  const user = (await database.select({ generation: schema.users.recoveryGeneration }).from(schema.users)
    .where(eq(schema.users.id, userId)).limit(1))[0];
  if (!user) throw AppError.unauthorized("User not found");
  const recoveryId = randomBytes(ID_BYTES).toString("base64url");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  await database.insert(schema.userRecoveryCodes).values({
    id: recoveryId,
    userId,
    secretDigest: digestRecoverySecret(key.key, recoveryId, secret),
    keyId: key.keyId,
    generation: user.generation,
    createdAt: now,
  });
  return { code: formatRecoveryCode(recoveryId, secret), issuedAt: now.toISOString() };
}

/** 有効なコードを持っているか (画面の表示と初回発行の判定に使う)。 */
export async function hasActiveRecoveryCode(userId: string, reader: Pick<typeof db, "select"> = db): Promise<boolean> {
  const row = (await reader.select({ id: schema.userRecoveryCodes.id }).from(schema.userRecoveryCodes).where(and(
    eq(schema.userRecoveryCodes.userId, userId),
    isNull(schema.userRecoveryCodes.revokedAt),
    isNull(schema.userRecoveryCodes.usedAt),
  )).limit(1))[0];
  return Boolean(row);
}
