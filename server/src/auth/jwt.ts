/**
 * JWT 生成・検証
 */

import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { AppError } from "../error.js";

const ACCESS_TOKEN_MINUTES = 60;
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

/**
 * 「あるユーザが、 ある project (Memoria Hub 等) を呼ぶための per-user 短命 token」
 * の claims。 `kind: "user_for_project"` で project_credentials 由来の service token と区別する。
 *
 * 既存の Memoria Hub authMiddleware は `payload.sub` を userId として読むので
 * `sub = userId` を維持する。 service 側で「このユーザが本当に許可された
 * project から来ているか」 を区別したい場合は claim `projectKey` を見る。
 */
export interface UserProjectJwtClaims {
  sub: string;          // userId
  projectKey: string;
  role: string;
  kind: "user_for_project";
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
    { expiresIn: `${ACCESS_TOKEN_MINUTES}m` },
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
    { algorithm: "HS256", expiresIn: `${ACCESS_TOKEN_MINUTES}m` },
  );
}

/**
 * User × Project の per-call short-lived token を発行する。
 *
 * ・Memoria local backend が「ログイン中ユーザの代わりに Memoria Hub を叩く」
 *   ようなケースに使う。 service 側は HS256 共有鍵でローカル検証する想定。
 * ・disk / Infisical に長持ちする secret を残さない設計のための入口。
 *   発行された token は呼び出し元の process memory にのみ載せて使う。
 */
export function generateUserProjectToken(
  userId: string,
  projectKey: string,
  role: string,
): string {
  return jwt.sign(
    { sub: userId, projectKey, role, kind: "user_for_project" },
    config.jwtSecret,
    { algorithm: "HS256", expiresIn: `${ACCESS_TOKEN_MINUTES}m` },
  );
}

export function verifyUserProjectToken(token: string): UserProjectJwtClaims {
  try {
    const claims = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] }) as UserProjectJwtClaims;
    if (claims.kind !== "user_for_project") {
      throw AppError.unauthorized("Not a user_for_project token");
    }
    return claims;
  } catch {
    throw AppError.unauthorized("Invalid or expired user_for_project token");
  }
}

export function verifyProjectToken(token: string): ProjectJwtClaims {
  try {
    const claims = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] }) as ProjectJwtClaims;
    if (claims.tokenType !== "project") {
      throw AppError.unauthorized("Not a project token");
    }
    return claims;
  } catch {
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
    return jwt.verify(token, config.jwtSecret) as JwtClaims;
  } catch {
    throw AppError.unauthorized("Invalid or expired token");
  }
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

export { REFRESH_TOKEN_DAYS };
