/**
 * Composite Auth Session (Redis)
 *
 * 資格情報 (email+password / OAuth / MFA) の検証後に、
 * デバイス本人確認フローを WS で完結させるためのセッション。
 *
 * 流れ:
 *   1. POST /api/auth/composite/login で資格情報検証 → createAuthSession()
 *   2. クライアントが ticket で `/auth/composite-ws?ticket=...` に接続
 *   3. WS から fingerprint 送信 → state 遷移を push
 *   4. 信頼済み / 本人確認成功 → state=authenticated, authCode 発行
 *
 * Redis キー: `auth_session:{ticket}` (TTL 10分)
 */

import crypto from "node:crypto";
import { redis } from "../redis.js";

export type AuthSessionState =
  | "pending_device"      // 資格情報OK、fingerprint 待ち
  | "challenge_pending"   // 未知デバイス、コード送信済み、コード入力待ち
  | "authenticated"       // 認証完了、authCode 発行済み
  | "expired";            // 明示的に破棄 (UI 表示用)

export interface AuthSessionUser {
  userId: string;
  displayName: string;
  email: string | null;
  role: string;
}

export interface AuthSession {
  ticket: string;
  state: AuthSessionState;
  user: AuthSessionUser;
  /** 本人確認中のチャレンジトークン (device_challenge:{deviceToken} と連動) */
  deviceToken?: string;
  /** 認証完了時に発行される authCode */
  authCode?: string;
  /** 最後の state 遷移エラー (retry 用) */
  lastError?: string;
  /** 作成元の ip (監査用) */
  ip?: string;
  userAgent?: string;
  createdAt: number;
}

const AUTH_SESSION_TTL = 10 * 60; // 10 分

function key(ticket: string): string {
  return `auth_session:${ticket}`;
}

export async function createAuthSession(
  user: AuthSessionUser,
  ctx: { ip?: string; userAgent?: string } = {},
): Promise<AuthSession> {
  const ticket = crypto.randomUUID();
  const session: AuthSession = {
    ticket,
    state: "pending_device",
    user,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    createdAt: Date.now(),
  };
  await redis.set(key(ticket), JSON.stringify(session), "EX", AUTH_SESSION_TTL);
  return session;
}

export async function getAuthSession(ticket: string): Promise<AuthSession | null> {
  const raw = await redis.get(key(ticket));
  if (!raw) return null;
  return JSON.parse(raw) as AuthSession;
}

export async function updateAuthSession(
  ticket: string,
  patch: Partial<Omit<AuthSession, "ticket" | "createdAt">>,
): Promise<AuthSession | null> {
  const current = await getAuthSession(ticket);
  if (!current) return null;
  const next: AuthSession = { ...current, ...patch };
  // TTL は常にリセット (アクティブ間は保持する)
  await redis.set(key(ticket), JSON.stringify(next), "EX", AUTH_SESSION_TTL);
  return next;
}

export async function deleteAuthSession(ticket: string): Promise<void> {
  await redis.del(key(ticket));
}
