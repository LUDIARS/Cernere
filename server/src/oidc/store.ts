/**
 * OIDC フローの短命レコードを Redis に保持する。
 *
 *   oidc:req:{id}    authorize リクエスト (consent 待ち)        TTL AUTH_REQUEST_TTL_SEC
 *   oidc:code:{code} authorization code (token 交換待ち、 1 回限り) TTL AUTH_CODE_TTL_SEC
 *   oidc:at:{token}  発行済 access_token (userinfo 用)          TTL ACCESS_TOKEN_TTL_SEC
 *
 * いずれも値は推測困難な乱数キーで参照する。
 */

import { randomBytes } from "node:crypto";
import { redis } from "../redis.js";
import { ACCESS_TOKEN_TTL_SEC, AUTH_CODE_TTL_SEC, AUTH_REQUEST_TTL_SEC } from "./scopes.js";

export interface AuthRequestRecord {
  clientId: string;
  redirectUri: string;
  scope: string[];
  state?: string;
  nonce?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

export interface AuthCodeRecord {
  clientId: string;
  redirectUri: string;
  scope: string[];
  nonce?: string;
  codeChallenge?: string;
  userId: string;
  authTime: number; // unix sec
}

export interface AccessTokenRecord {
  userId: string;
  clientId: string;
  scope: string[];
}

function newId(): string {
  return randomBytes(24).toString("base64url");
}

// ── authorize request ─────────────────────────────────────────

export async function putAuthRequest(rec: AuthRequestRecord): Promise<string> {
  const id = newId();
  await redis.set(`oidc:req:${id}`, JSON.stringify(rec), "EX", AUTH_REQUEST_TTL_SEC);
  return id;
}

export async function getAuthRequest(id: string): Promise<AuthRequestRecord | null> {
  const raw = await redis.get(`oidc:req:${id}`);
  return raw ? (JSON.parse(raw) as AuthRequestRecord) : null;
}

export async function deleteAuthRequest(id: string): Promise<void> {
  await redis.del(`oidc:req:${id}`);
}

// ── authorization code ────────────────────────────────────────

export async function putAuthCode(rec: AuthCodeRecord): Promise<string> {
  const code = newId();
  await redis.set(`oidc:code:${code}`, JSON.stringify(rec), "EX", AUTH_CODE_TTL_SEC);
  return code;
}

/** code を取得し即削除する (one-time use)。 取得できなければ null。 */
export async function consumeAuthCode(code: string): Promise<AuthCodeRecord | null> {
  const key = `oidc:code:${code}`;
  // GETDEL で取得と削除を原子的に行い、 並行な二重交換を防ぐ。
  const raw = await redis.getdel(key);
  return raw ? (JSON.parse(raw) as AuthCodeRecord) : null;
}

// ── access token ──────────────────────────────────────────────

export async function putAccessToken(rec: AccessTokenRecord): Promise<string> {
  const token = newId();
  await redis.set(`oidc:at:${token}`, JSON.stringify(rec), "EX", ACCESS_TOKEN_TTL_SEC);
  return token;
}

export async function getAccessToken(token: string): Promise<AccessTokenRecord | null> {
  const raw = await redis.get(`oidc:at:${token}`);
  return raw ? (JSON.parse(raw) as AccessTokenRecord) : null;
}
