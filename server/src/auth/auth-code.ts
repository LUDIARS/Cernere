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
import { requireActiveUser } from "./user-access.js";
import { enforceServiceConsent, type ServiceConsentRequest } from "../consent/gate.js";

import type { AuthenticationEvidence } from "../lib/authentication-evidence.js";
import type { UserSessionState } from "./user-session-state.js";

const AUTH_CODE_TTL = 60;

/**
 * authCode の用途 (許可制 案 A)。
 *   service  サービスへ渡す (popup / redirect / silent SSO / サービス経由)。active のユーザーにだけ発行する
 *   cernere  Cernere 自身の /login。許可待ちでも発行するが、交換は Cernere の画面からだけ受け付ける
 */
export type AuthCodeAudience = "service" | "cernere";

export interface AuthCodeUser {
  /** 既定は service (外へ出る側に倒す) */
  audience?: AuthCodeAudience;
  authentication?: AuthenticationEvidence;
  authEpoch?: number;
  deviceId?: string;
  userId: string;
  displayName: string;
  email: string | null;
  role: string;
  /**
   * サービス向け (audience = "service") では必須: どのサービスへ渡すか。
   * 同意の関門 (spec/plan/2026-10-15-service-consent-design.md §4.1) がこれで判定する。
   */
  service?: ServiceConsentRequest;
}

export async function issueAuthCode(user: AuthCodeUser): Promise<string> {
  const audience = user.audience ?? "service";
  if (audience === "service") {
    // 許可待ち・停止中のユーザーをサービスへ入れない。refresh 行を作る前に止める。
    await requireActiveUser(user.userId);
    if (!user.service) throw new Error("issueAuthCode: a service target is required for service auth codes");
    // 同意が要るなら authCode を出さず ConsentRequiredError を投げる (consent_mode 既定 off)。
    await enforceServiceConsent({
      userId: user.userId, displayName: user.displayName, email: user.email, role: user.role,
      authentication: user.authentication, authEpoch: user.authEpoch, deviceId: user.deviceId,
    }, user.service);
  }
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
    audience,
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

/** userId から users テーブルを引いて、サービス向けの authCode を発行する */
export async function issueAuthCodeForUserId(
  userId: string,
  service: ServiceConsentRequest,
  source?: UserSessionState,
): Promise<string | null> {
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
    service,
  });
}
