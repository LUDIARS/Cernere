/**
 * JWT 生成・検証
 */

import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { AppError } from "../error.js";
import { devLog } from "../logging/dev-logger.js";

// user access token はステートレスで即時 revoke できないため、 露出時間を短く保つ。
// 長期の継続ログインは refresh token (30日) 経由に寄せる。
const ACCESS_TOKEN_MINUTES = 15;
// service-to-service token (tool / project HS256) は別枠で 60 分。
// user のセッション UX とは切り離す。
const SERVICE_TOKEN_MINUTES = 60;
const REFRESH_TOKEN_DAYS = 30;

export interface JwtClaims {
  sub: string;   // user ID
  role: string;
  iat: number;
  exp: number;
}

export interface ToolJwtClaims {
  sub: string;   // tool_client.id
  owner: string; // owner_user_id
  scopes: string[];
  iat: number;
  exp: number;
}

export interface ProjectJwtClaims {
  sub: string;      // client_id
  projectKey: string;
  tokenType: "project";
  iat: number;
  exp: number;
}

export function generateAccessToken(userId: string, role: string): string {
  return jwt.sign(
    { sub: userId, role },
    config.jwtSecret,
    { expiresIn: `${ACCESS_TOKEN_MINUTES}m` },
  );
}

export function generateTokenPair(userId: string, role: string): { accessToken: string; refreshToken: string } {
  const accessToken = generateAccessToken(userId, role);
  const refreshToken = crypto.randomUUID();
  return { accessToken, refreshToken };
}

export function generateToolToken(toolClientId: string, ownerUserId: string, scopes: string[]): string {
  return jwt.sign(
    { sub: toolClientId, owner: ownerUserId, scopes },
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
export function generateProjectToken(clientId: string, projectKey: string): string {
  return jwt.sign(
    { sub: clientId, projectKey, tokenType: "project" },
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
    { sub: userId, role },
    config.jwtSecret,
    { expiresIn: "5m" },
  );
}

export function verifyToken(token: string): JwtClaims {
  try {
    // algorithm を HS256 に固定する。 pin しないと将来 verify 側が別 alg を受理する
    // 余地を残し、 algorithm-confusion の温床になるため明示する
    // (verifyProjectToken と同じ扱いに揃える)。
    return jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] }) as JwtClaims;
  } catch {
    throw AppError.unauthorized("Invalid or expired token");
  }
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

export { REFRESH_TOKEN_DAYS };
