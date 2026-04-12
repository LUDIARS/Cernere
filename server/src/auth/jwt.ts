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

export function generateProjectToken(clientId: string, projectKey: string): string {
  return jwt.sign(
    { sub: clientId, projectKey, tokenType: "project" },
    config.jwtSecret,
    { expiresIn: `${ACCESS_TOKEN_MINUTES}m` },
  );
}

export function verifyProjectToken(token: string): ProjectJwtClaims {
  try {
    const claims = jwt.verify(token, config.jwtSecret) as ProjectJwtClaims;
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
