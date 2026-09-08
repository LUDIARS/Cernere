/**
 * Device Credential の発行・検証・失効
 * (spec/plan/passkey-default-authentication.md §7.2 / §10 / §11 / §12.1)
 *
 * Device Credential は **UX 最適化レイヤ**であり、 信頼の根ではない。
 * 単独では新しいパスキーの追加・削除、 全端末失効、 回復処理を実行できない。
 * 失効・期限切れ・ローテーション競合ではパスキー認証へ戻す。
 *
 * ローテーションの判断そのものは device-rotation.ts の純関数に置き、
 * ここは行ロックと永続化に徹する。
 */

import { randomUUID, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { readAuthenticationEvidence, type AuthenticationEvidence } from "../lib/authentication-evidence.js";
import {
  deriveSubkey,
  loadSessionKeyMaterial,
  computeSecretHash,
  secretHashEquals,
  type SessionKeyMaterial,
} from "./session-keys.js";
import { DEVICE_TOKEN_PREFIX, formatDeviceToken, parseDeviceToken } from "./device-token.js";
import {
  decideRotation,
  type DeviceCredentialState,
  type RotationKeys,
} from "./device-rotation.js";

/** §10.2 の既定値。 production で無期限を許可しない。 */
export const DEVICE_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type DeviceClientKind = "browser" | "native";

/** §7.2 の revoked_reason。 */
export type DeviceRevokeReason =
  | "logout"
  | "replay"
  | "admin"
  | "recovery"
  | "passkey_revoked"
  | "key_rotation"
  | "expired";

export interface IssuedDeviceCredential {
  deviceId: string;
  token: string;
  expiresAt: Date;
}

/** 認証設定画面に出す端末セッションの一覧項目。 */
export interface DeviceCredentialSummary {
  deviceId: string;
  clientKind: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

let cachedKeys: { material: SessionKeyMaterial; rotation: RotationKeys } | null = null;

/**
 * subkey を導出してキャッシュする。
 *
 * import 時ではなく初回利用時に読むのは、 DB しか触らない管理 CLI が
 * 「session key が無い」 だけで起動できなくなるのを避けるため (config.jwtSecret と同じ方針)。
 */
function keys(): { material: SessionKeyMaterial; rotation: RotationKeys } {
  if (!cachedKeys) {
    const material = loadSessionKeyMaterial();
    cachedKeys = {
      material,
      rotation: {
        verifyKey: deriveSubkey(material.master, "device/verify"),
        rotateKey: deriveSubkey(material.master, "device/rotate"),
      },
    };
  }
  return cachedKeys;
}

/** テスト用。 env を差し替えた後に再読込させる。 */
export function resetDeviceCredentialKeys(): void {
  cachedKeys = null;
}

/**
 * パスキー検証後に新しい端末セッションを発行する (§9.1 / §9.2)。
 *
 * 初回 secret だけは導出ではなく乱数にする。 導出は「同じ rotation_id の再送に
 * 同じ token を返す」 ための仕組みで、 新規発行には冪等性の要求が無いため。
 */
export async function issueDeviceCredential(params: {
  userId: string;
  rootPasskeyId: string;
  authentication: AuthenticationEvidence;
  authEpoch: number;
  clientKind: DeviceClientKind;
  now?: Date;
}): Promise<IssuedDeviceCredential> {
  const { material, rotation } = keys();
  const now = params.now ?? new Date();
  const deviceId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + DEVICE_CREDENTIAL_TTL_MS);

  await db.transaction(async (tx) => {
    const user = (await tx.select().from(schema.users).where(eq(schema.users.id, params.userId)).for("update"))[0];
    const passkey = (await tx.select().from(schema.passkeys).where(and(eq(schema.passkeys.id, params.rootPasskeyId), eq(schema.passkeys.userId, params.userId), isNull(schema.passkeys.revokedAt))).limit(1))[0];
    const authentication = readAuthenticationEvidence(params.authentication);
    if (!user || !passkey || !authentication || (!authentication.amr.includes("pop") || !authentication.amr.includes("mfa")) || authentication.revision !== user.mfaRevision || params.authEpoch !== user.authEpoch) throw AppError.unauthorized("Passkey authentication changed");
    await tx.insert(schema.deviceCredentials).values({
    id: deviceId,
    userId: params.userId,
    rootPasskeyId: params.rootPasskeyId,
    clientKind: params.clientKind,
    tokenKeyId: material.keyId,
    authentication,
    authEpoch: user.authEpoch,
    generation: 0,
    currentSecretHash: computeSecretHash(rotation.verifyKey, DEVICE_TOKEN_PREFIX, deviceId, secret),
    expiresAt,
    lastUsedAt: now,
    createdAt: now,
    });
  });

  return { deviceId, token: formatDeviceToken(deviceId, secret), expiresAt };
}

export interface DeviceSessionResult {
  userId: string;
  /** user の実ロール。 access token へは必ずこの値を載せる (固定値を書かない)。 */
  role: string;
  deviceId: string;
  /** クライアントが保存すべき token。 keep / replay では実質同じ値になる。 */
  token: string;
  expiresAt: Date;
  /** この行が発行された時点の user の auth_epoch。 access token に載せる。 */
  authEpoch: number;
  authentication: AuthenticationEvidence;
}

/**
 * token を検証し、 必要ならローテーションして新しい token を返す (§11.3)。
 *
 * 行ロックで直列化し、 判定は純関数へ委ねる。 失効させる場合も対象は当該 device 行
 * だけに限り、 他端末や passkey を巻き込まない。
 */
export async function rotateDeviceSession(params: {
  token: string | null | undefined;
  rotationId: string;
  now?: Date;
}): Promise<DeviceSessionResult> {
  const parsed = parseDeviceToken(params.token);
  if (!parsed) {
    throw AppError.withCode(401, "DEVICE_CREDENTIAL_MISSING", "Device credential is missing");
  }
  const { material, rotation } = keys();
  const now = params.now ?? new Date();

  return db.transaction(async (tx) => {
    const owner = (await tx.select({ userId: schema.deviceCredentials.userId }).from(schema.deviceCredentials).where(eq(schema.deviceCredentials.id, parsed.deviceId)).limit(1))[0];
    if (!owner) throw AppError.withCode(401, "DEVICE_CREDENTIAL_INVALID", "Device credential is invalid");
    // All issuance, rotation and revocation paths acquire the user lock before device rows.
    const user = (await tx.select().from(schema.users).where(eq(schema.users.id, owner.userId)).for("update"))[0];
    const rows = await tx.select().from(schema.deviceCredentials)
      .where(eq(schema.deviceCredentials.id, parsed.deviceId))
      .for("update");
    const row = rows[0];
    if (!row) {
      // 存在しない device_id。 「そんな端末は無い」 と「secret が違う」 を
      // 区別して返さない (§11.4 — 本文にユーザー有無を含めない)。
      throw AppError.withCode(401, "DEVICE_CREDENTIAL_INVALID", "Device credential is invalid");
    }

    const authentication = readAuthenticationEvidence(row.authentication);
    const passkey = row.rootPasskeyId ? (await tx.select({ id: schema.passkeys.id }).from(schema.passkeys).where(and(eq(schema.passkeys.id, row.rootPasskeyId), eq(schema.passkeys.userId, row.userId), isNull(schema.passkeys.revokedAt))).limit(1))[0] : null;
    if (!user || !passkey || !authentication || row.authEpoch !== user.authEpoch || authentication.revision !== user.mfaRevision || row.tokenKeyId !== material.keyId) {
      throw AppError.withCode(401, "PASSKEY_REQUIRED", "Device authentication changed");
    }
    const state: DeviceCredentialState = {
      id: row.id,
      generation: row.generation,
      currentSecretHash: row.currentSecretHash,
      previousSecretHash: row.previousSecretHash,
      previousValidUntil: row.previousValidUntil,
      lastRotationId: row.lastRotationId,
      lastRotatedAt: row.lastRotatedAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };

    const decision = decideRotation(
      state,
      { presentedSecret: parsed.secret, rotationId: params.rotationId, now },
      rotation,
    );

    if (decision.kind === "error") {
      throw toRotationError(decision.code);
    }

    const expiresAt = row.expiresAt;
    if (decision.kind === "rotate") {
      await tx.update(schema.deviceCredentials).set({
        generation: decision.nextGeneration,
        currentSecretHash: decision.nextSecretHash,
        previousSecretHash: row.currentSecretHash,
        previousValidUntil: decision.previousValidUntil,
        lastRotationId: params.rotationId,
        lastRotatedAt: now,
        lastUsedAt: now,
        expiresAt,
      }).where(eq(schema.deviceCredentials.id, row.id));
    } else {
      // Retries preserve the original absolute deadline and authentication time.
      await tx.update(schema.deviceCredentials).set({ lastUsedAt: now, expiresAt })
        .where(eq(schema.deviceCredentials.id, row.id));
    }

    return {
      userId: row.userId,
      role: user.role,
      deviceId: row.id,
      token: formatDeviceToken(row.id, decision.secret),
      expiresAt,
      authEpoch: user.authEpoch,
      authentication,
    };
  });
}

/**
 * token の持ち主を特定するだけの読み取り専用解決 (logout 用)。
 *
 * logout でローテーションを走らせてはいけない。 走らせると世代が進み、
 * クライアントが受け取れない secret へ書き換わった上で失効に進むことになり、
 * 失効側が失敗した場合に「回ったが revoke されていない」 行が残る。
 * また rotation_id を要求しないので、 ヘッダ無し logout でも確実に revoke できる。
 *
 * 失効済み・期限切れでも userId / deviceId は返す。 呼び出し側は冪等に revoke する。
 */
export async function resolveDeviceSession(
  token: string | null | undefined,
): Promise<{ userId: string; deviceId: string } | null> {
  const parsed = parseDeviceToken(token);
  if (!parsed) return null;
  const { rotation } = keys();

  const rows = await db.select().from(schema.deviceCredentials)
    .where(eq(schema.deviceCredentials.id, parsed.deviceId)).limit(1);
  const row = rows[0];
  if (!row) return null;

  // secret を確認できない相手に他人の端末を切らせない。 現行世代と grace 内の
  // 旧世代のどちらでも本人と認める (logout は冪等で良い)。
  const presentedHash = computeSecretHash(
    rotation.verifyKey, DEVICE_TOKEN_PREFIX, row.id, parsed.secret,
  );
  const matchesCurrent = secretHashEquals(presentedHash, row.currentSecretHash);
  const matchesPrevious = row.previousSecretHash != null
    && row.previousValidUntil != null && row.previousValidUntil.getTime() > Date.now()
    && secretHashEquals(presentedHash, row.previousSecretHash);
  if (!matchesCurrent && !matchesPrevious) return null;

  return { userId: row.userId, deviceId: row.id };
}

function toRotationError(code: string): AppError {
  if (code === "DEVICE_ROTATION_CONFLICT") {
    return AppError.withCode(409, code, "Device credential rotation is in flight");
  }
  return AppError.withCode(401, code, "Device credential requires passkey re-authentication");
}

/** 認証設定画面に出す端末セッション一覧 (失効済みは含めない)。 */
export async function listDeviceCredentials(userId: string): Promise<DeviceCredentialSummary[]> {
  const rows = await db.select({
    deviceId: schema.deviceCredentials.id,
    clientKind: schema.deviceCredentials.clientKind,
    createdAt: schema.deviceCredentials.createdAt,
    lastUsedAt: schema.deviceCredentials.lastUsedAt,
    expiresAt: schema.deviceCredentials.expiresAt,
  }).from(schema.deviceCredentials)
    .where(and(
      eq(schema.deviceCredentials.userId, userId),
      isNull(schema.deviceCredentials.revokedAt),
      gt(schema.deviceCredentials.expiresAt, new Date()),
    ));
  return rows;
}

/**
 * 端末セッションを 1 件失効する。
 *
 * **passkey 行には触らない** (§12.1)。 Device Credential の失効は端末の締め出しで
 * あって、 認証手段そのものの削除ではない。 ここで passkey を消すと、 端末を 1 台
 * 手放しただけでアカウントの認証手段が減ってしまう。
 */
export async function revokeDeviceCredential(params: {
  userId: string;
  deviceId: string;
  reason: DeviceRevokeReason;
  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  const revoked = await db.update(schema.deviceCredentials)
    .set({ revokedAt: now, revokedReason: params.reason })
    .where(and(
      eq(schema.deviceCredentials.id, params.deviceId),
      eq(schema.deviceCredentials.userId, params.userId),
      isNull(schema.deviceCredentials.revokedAt),
    ))
    .returning({ id: schema.deviceCredentials.id });
  return revoked.length > 0;
}

/**
 * user の全端末セッションを失効し、 auth_epoch を進める (§12.1「全端末から logout」)。
 *
 * JWT / WS 検証は現在の auth_epoch を確認する。MFA revision も進め、
 * 未完了チャレンジと企業 SSO の旧認証事実を再利用させない。passkey は維持する。
 */
export async function revokeAllDeviceCredentials(params: {
  userId: string;
  reason: DeviceRevokeReason;
  now?: Date;
}): Promise<number> {
  const now = params.now ?? new Date();
  return db.transaction(async (tx) => {
    await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, params.userId)).for("update");
    const revoked = await tx.update(schema.deviceCredentials)
      .set({ revokedAt: now, revokedReason: params.reason })
      .where(and(
        eq(schema.deviceCredentials.userId, params.userId),
        isNull(schema.deviceCredentials.revokedAt),
      ))
      .returning({ id: schema.deviceCredentials.id });
    await tx.update(schema.users)
      .set({ authEpoch: sql`${schema.users.authEpoch} + 1`, mfaRevision: sql`${schema.users.mfaRevision} + 1` })
      .where(eq(schema.users.id, params.userId));
    await tx.delete(schema.refreshSessions).where(eq(schema.refreshSessions.userId, params.userId));
    return revoked.length;
  });
}
