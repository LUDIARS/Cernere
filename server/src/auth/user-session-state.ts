/** Current user and device authorization for Cr user sessions. @implements SPEC-DEVICE-REVOCATION */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users, deviceCredentials, passkeys } from "../db/schema.js";
import { AppError } from "../error.js";
import { config } from "../config.js";
import { readAuthenticationEvidence, type AuthenticationEvidence } from "../lib/authentication-evidence.js";
import { loadSessionKeyMaterial } from "./session-keys.js";
import { parseAccessStatus } from "./user-access.js";
import { resolveEffectiveRole } from "../federation/effective-role.js";

export interface UserSessionState {
  sub: string;
  role: string;
  authEpoch?: number;
  mfaRevision?: number;
  deviceId?: string;
  authentication?: AuthenticationEvidence;
}

export type SessionReader = Pick<typeof db, "select">;

export async function currentUserSessionState(userId: string, reader: SessionReader = db): Promise<Required<Pick<UserSessionState, "sub" | "role" | "authEpoch" | "mfaRevision">>> {
  const user = (await reader.select({
    sub: users.id, role: users.role, authEpoch: users.authEpoch, mfaRevision: users.mfaRevision, accessStatus: users.accessStatus,
  }).from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!user) throw AppError.unauthorized("User session is no longer valid");
  // 停止したアカウントはどの経路のセッションも通さない (許可制 案 A)。pending は本人用操作のため通す。
  if (parseAccessStatus(user.accessStatus) === "locked") throw AppError.unauthorized("This account is locked");
  // role は有効な role (連携していれば主の role、account-federation §3.1)。主の role が変わる・
  // 連携に入る / 外れると既存トークンの role と食い違い、再発行 (refresh) を求める。
  const role = await resolveEffectiveRole(user.sub, user.role, reader);
  return { sub: user.sub, role, authEpoch: user.authEpoch, mfaRevision: user.mfaRevision };
}

/**
 * トークン発行の呼び出し側が渡した role が今の状態と合っているか。
 * 呼び出し側はアカウント自身の users.role を読んで渡すことが多いので、有効な role か
 * アカウント自身の role のどちらかに一致すれば合っているとみなす (発行される role は常に有効な role)。
 */
export async function issuedRoleMatchesCurrent(userId: string, role: string, effectiveRole: string, reader: SessionReader = db): Promise<boolean> {
  if (role === effectiveRole) return true;
  const own = (await reader.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1))[0];
  return own !== undefined && own.role === role;
}

export async function assertUserSessionCurrent(claims: UserSessionState, reader: SessionReader = db): Promise<void> {
  const user = await currentUserSessionState(claims.sub, reader);
  // Pre-migration user tokens are accepted only before the first explicit global revocation.
  if ((claims.authEpoch ?? 0) !== user.authEpoch || claims.role !== user.role
    || (claims.mfaRevision !== undefined && claims.mfaRevision !== user.mfaRevision)) {
    throw AppError.unauthorized("User session was revoked");
  }
  const authentication = readAuthenticationEvidence(claims.authentication);
  if (authentication && authentication.revision !== user.mfaRevision) throw AppError.unauthorized("Authentication changed");
  if (!claims.deviceId) return;
  if (!config.deviceSessionsEnabled) throw AppError.unauthorized("Device sessions are not enabled");
  const row = (await reader.select({ device: deviceCredentials }).from(deviceCredentials)
    .innerJoin(passkeys, and(eq(passkeys.id, deviceCredentials.rootPasskeyId), eq(passkeys.userId, deviceCredentials.userId), isNull(passkeys.revokedAt)))
    .where(and(eq(deviceCredentials.id, claims.deviceId), eq(deviceCredentials.userId, user.sub), isNull(deviceCredentials.revokedAt))).limit(1))[0]?.device;
  const original = readAuthenticationEvidence(row?.authentication);
  // key id は生 env ではなく loadSessionKeyMaterial 経由で読む。 生 env だと
  // 長さ検証を素通りし、 rotateDeviceSession 側 (keys() 経由) と判定がずれる。
  if (!row || row.tokenKeyId !== loadSessionKeyMaterial().keyId || row.expiresAt.getTime() <= Date.now() || row.authEpoch !== user.authEpoch || !original
    || original.revision !== user.mfaRevision || !authentication || original.authTime !== authentication.authTime || original.authTimeMs !== authentication.authTimeMs
    || original.amr.join(",") !== authentication.amr.join(",")) {
    throw AppError.unauthorized("Device session was revoked");
  }
}
