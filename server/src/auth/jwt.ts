/**
 * JWT 生成・検証
 */

import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { AppError } from "../error.js";
import { devLog } from "../logging/dev-logger.js";
import { readAuthenticationEvidence, type AuthenticationEvidence } from "../lib/authentication-evidence.js";
import { assertUserSessionCurrent, currentUserSessionState, type UserSessionState, type SessionReader } from "./user-session-state.js";

// User JWTs have a short lifetime and also check current user/device revocation state.
// Device refresh retains the original authentication time and absolute expiry.
export const ACCESS_TOKEN_SECONDS = 15 * 60;
// service-to-service token (tool / project HS256) は別枠で 60 分。
// user のセッション UX とは切り離す。
const SERVICE_TOKEN_MINUTES = 60;
const REFRESH_TOKEN_DAYS = 30;

export interface JwtClaims extends UserSessionState {
  tokenType: "user_access";
  sub: string;   // user ID
  role: string;
  iat: number;
  exp: number;
}

export interface ToolJwtClaims {
  tokenType: "tool";
  sub: string;   // tool_client.id
  owner: string; // owner_user_id
  scopes: string[];
  iat: number;
  exp: number;
}

export interface ProjectJwtClaims {
  sub: string;      // client_id
  projectKey: string;
  /** 旧tokenとの移行互換のため省略時は0として扱う。 */
  credentialGeneration?: number;
  tokenType: "project";
  iat: number;
  exp: number;
}

export async function generateAccessToken(userId: string, role: string, authentication?: AuthenticationEvidence,
  context: { deviceId?: string; authEpoch?: number; database?: SessionReader } = {}): Promise<string> {
  const current = await currentUserSessionState(userId, context.database);
  if (role !== current.role || (context.authEpoch !== undefined && context.authEpoch !== current.authEpoch)) {
    throw AppError.unauthorized("Authentication changed before session issuance");
  }
  const claims = { ...current, deviceId: context.deviceId, authentication: readAuthenticationEvidence(authentication), tokenType: "user_access" };
  await assertUserSessionCurrent(claims, context.database);
  return jwt.sign(
    claims,
    config.jwtSecret,
    { expiresIn: ACCESS_TOKEN_SECONDS },
  );
}

export async function generateTokenPair(userId: string, role: string, authentication?: AuthenticationEvidence,
  context: { authEpoch?: number; deviceId?: string; database?: SessionReader } = {}): Promise<{ accessToken: string; refreshToken: string; authEpoch: number }> {
  const current = await currentUserSessionState(userId, context.database);
  const authEpoch = context.authEpoch ?? current.authEpoch;
  const accessToken = await generateAccessToken(userId, role, authentication, { authEpoch, deviceId: context.deviceId, database: context.database });
  const refreshToken = crypto.randomUUID();
  return { accessToken, refreshToken, authEpoch };
}

export function generateToolToken(toolClientId: string, ownerUserId: string, scopes: string[]): string {
  return jwt.sign(
    { sub: toolClientId, owner: ownerUserId, scopes, tokenType: "tool" },
    config.jwtSecret,
    { expiresIn: `${SERVICE_TOKEN_MINUTES}m` },
  );
}

/**
 * Project token は HS256 (対称鍵) で署名する. ピアサービス側のローカル検証は
 * 行わず、必要なら Cernere の `managed_project.verify_token` WS コマンドに
 * 検証を委譲する設計. これにより Cernere 内に RSA 鍵管理 / JWKS 機構を
 * 持たずに済む.
 */
export function generateProjectToken(
  clientId: string,
  projectKey: string,
  credentialGeneration = 0,
): string {
  return jwt.sign(
    { sub: clientId, projectKey, credentialGeneration, tokenType: "project" },
    config.jwtSecret,
    { algorithm: "HS256", expiresIn: `${SERVICE_TOKEN_MINUTES}m` },
  );
}

/**
 * 注: 「ユーザ × project」 の per-call token (`kind: "user_for_project"`) は
 * PASETO Ed25519 (aud 必須) に一本化した。 HS256 版 (旧 `generateUserProjectToken` /
 * `verifyUserProjectToken`) は鍵横展開 + aud 無し横断偽造のリスクがあるため撤去済み。
 * 発行は `auth/paseto.ts` の `signProjectToken`、 検証は service 側が公開鍵で行う。
 */
export function verifyProjectToken(token: string): ProjectJwtClaims {
  try {
    const claims = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] }) as ProjectJwtClaims;
    if (claims.tokenType !== "project") {
      throw AppError.unauthorized("Not a project token");
    }
    return claims;
  } catch (err) {
    // M-4: 同上。 内部ログに err.name、 ユーザー応答は曖昧なまま。
    if (err instanceof AppError) throw err;
    devLog("auth.verifyProjectToken.failed", { reason: (err as Error)?.name ?? "unknown" });
    throw AppError.unauthorized("Invalid or expired project token");
  }
}

export function generateMfaToken(userId: string, role: string): string {
  return jwt.sign(
    { sub: userId, role, tokenType: "mfa_challenge" },
    config.jwtSecret,
    { expiresIn: "5m" },
  );
}

export async function verifyToken(token: string): Promise<JwtClaims> {
  let typed: JwtClaims;
  try {
    const claims = verifyTypedClaims(token, "user_access");
    if (typeof claims.role !== "string" || !claims.role.trim()
      || claims.owner !== undefined || claims.scopes !== undefined || claims.projectKey !== undefined) {
      throw AppError.unauthorized("Invalid user access token");
    }
    for (const key of ["authEpoch", "mfaRevision"] as const) {
      if (claims[key] !== undefined && (!Number.isSafeInteger(claims[key]) || Number(claims[key]) < 0)) throw AppError.unauthorized("Invalid session revision");
    }
    if (claims.deviceId !== undefined && typeof claims.deviceId !== "string") throw AppError.unauthorized("Invalid device session");
    typed = claims as unknown as JwtClaims;
  } catch {
    // 署名・形式の検証はここで完結する (DB へ触れない)。
    throw AppError.unauthorized("Invalid or expired token");
  }
  // 失効確認は DB 参照を伴う。 AppError (= 失効・改竄と判定できたもの) だけを
  // 401 に落とし、 接続断などの基盤障害は 503 のまま伝播させる。
  // ここで全部 401 に潰すと、 一過性の DB 障害が「全ユーザーのトークン失効」 と
  // 区別できなくなり、 クライアントが資格情報を捨てて恒久ログアウトになる。
  await assertUserSessionCurrent(typed);
  return typed;
}

/** Tool credentials are accepted only by callers that explicitly request tool authorization. */
export function verifyToolToken(token: string): ToolJwtClaims {
  try {
    const claims = verifyTypedClaims(token, "tool");
    if (typeof claims.owner !== "string" || !claims.owner.trim()
      || !Array.isArray(claims.scopes) || !claims.scopes.every((scope) => typeof scope === "string")
      || claims.role !== undefined || claims.projectKey !== undefined) {
      throw AppError.unauthorized("Invalid tool token");
    }
    return claims as unknown as ToolJwtClaims;
  } catch {
    throw AppError.unauthorized("Invalid or expired tool token");
  }
}

/** Old untyped tokens cannot prove MFA completion and intentionally require reauthentication. */
function verifyTypedClaims(token: string, tokenType: "user_access" | "tool"): jwt.JwtPayload {
  const claims = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
  if (typeof claims === "string" || claims.tokenType !== tokenType
    || typeof claims.sub !== "string" || !claims.sub.trim()
    || typeof claims.iat !== "number" || !Number.isInteger(claims.iat)
    || typeof claims.exp !== "number" || !Number.isInteger(claims.exp)
    || claims.exp <= claims.iat) {
    throw AppError.unauthorized("Invalid token purpose or claims");
  }
  return claims;
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

export { REFRESH_TOKEN_DAYS };
