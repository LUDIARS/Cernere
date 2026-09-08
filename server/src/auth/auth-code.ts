/**
 * authCode 発行ヘルパー。
 *
 * 認証済みユーザー用のアクセストークン/リフレッシュトークンペアを生成し、
 * Redis `authcode:{code}` キー (TTL 60 秒) に格納する。
 * 受け取り側は `POST /api/auth/exchange { code }` で実トークンに交換する。
 *
 * 従来 composite-auth.ts 内に限定されていたが、ダッシュボード等からも
 * 「認証済みで別サービスを開く」操作に再利用するため共通モジュール化。
 */

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { generateTokenPair, REFRESH_TOKEN_DAYS } from "./jwt.js";
import { hashRefreshToken } from "./token-hash.js";
import { redis } from "../redis.js";

import type { AuthenticationEvidence } from "../lib/authentication-evidence.js";
import type { UserSessionState } from "./user-session-state.js";

const AUTH_CODE_TTL = 60;

export interface AuthCodeUser {
  authentication?: AuthenticationEvidence;
  authEpoch?: number;
  deviceId?: string;
  userId: string;
  displayName: string;
  email: string | null;
  role: string;
}

export async function issueAuthCode(user: AuthCodeUser): Promise<string> {
  const { accessToken, refreshToken, authEpoch } = await generateTokenPair(user.userId, user.role, user.authentication, { authEpoch: user.authEpoch, deviceId: user.deviceId });
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(schema.refreshSessions).values({
    authentication: user.authentication, deviceId: user.deviceId, authEpoch, id: crypto.randomUUID(),
    userId: user.userId,
    refreshToken: hashRefreshToken(refreshToken),
    expiresAt,
  });
  const authCode = crypto.randomUUID();
  await redis.set(`authcode:${authCode}`, JSON.stringify({
    accessToken,
    refreshToken,
    user: {
      id: user.userId,
      displayName: user.displayName,
      email: user.email,
      role: user.role,
    },
  }), "EX", AUTH_CODE_TTL);
  return authCode;
}

/** userId から users テーブルを引いて authCode を発行する */
export async function issueAuthCodeForUserId(userId: string, source?: UserSessionState): Promise<string | null> {
  if (source && source.sub !== userId) throw new Error("Auth code source mismatch");
  const rows = await db.select({
    id: schema.users.id,
    displayName: schema.users.displayName,
    email: schema.users.email,
    role: schema.users.role,
  }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (rows.length === 0) return null;
  const u = rows[0];
  return issueAuthCode({
    authentication: source?.authentication, authEpoch: source?.authEpoch, deviceId: source?.deviceId,
    userId: u.id,
    displayName: u.displayName ?? "",
    email: u.email,
    role: u.role ?? "general",
  });
}
