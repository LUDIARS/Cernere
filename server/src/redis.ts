/**
 * Redis クライアント (ioredis)
 *
 * セッション管理、ユーザーステート、レートリミット
 */

import Redis from "ioredis";
import { config } from "./config.js";
import { verifyToken } from "./auth/jwt.js";
import { assertUserSessionCurrent, type UserSessionState } from "./auth/user-session-state.js";
import { AppError } from "./error.js";

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  // REDIS_DB があれば URL の DB 番号より優先する (本社テスト用の分離)。
  ...(config.redisDb !== undefined ? { db: config.redisDb } : {}),
});

redis.on("connect", () => console.log("[redis] Connected"));
redis.on("error", (err) => console.error("[redis] Error:", err.message));

// ── Session TTL ──────────────────────────────────────────────

export const SESSION_TTL_SECS = 7 * 24 * 60 * 60; // 7 days

// ── Session operations ───────────────────────────────────────

export interface RedisSession {
  id: string;
  userId: string;
  expiresAt: string; // ISO 8601
  accessToken: string;
  authorization?: UserSessionState;
}

/**
 * WS の再接続用セッションを保存する。寿命は元の access token の期限で打ち切る。
 * 7 日のままだと、漏れた access token で 1 回つないだだけで、token の期限切れ後も
 * 利用者のログアウト後も session_id で再接続できてしまう (2026-10-29 の点検)。
 */
export async function putSession(session: RedisSession): Promise<void> {
  const authorization = await verifyToken(session.accessToken);
  if (authorization.sub !== session.userId) throw new Error("Session user mismatch");
  const expiresAtMs = sessionExpiry(Date.parse(session.expiresAt), authorization.exp);
  const ttlSecs = Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 1000));
  const key = `session:${session.id}`;
  await redis.set(key, JSON.stringify({
    ...session, expiresAt: new Date(expiresAtMs).toISOString(), authorization, authenticationVersion: 3,
  }), "EX", ttlSecs);
}

/** 要求された期限と access token の exp (秒) の早いほう。どちらも無効なら今から SESSION_TTL_SECS。 */
export function sessionExpiry(requestedMs: number, tokenExpSecs: unknown, now = Date.now()): number {
  const candidates = [now + SESSION_TTL_SECS * 1000];
  if (Number.isFinite(requestedMs)) candidates.push(requestedMs);
  if (typeof tokenExpSecs === "number" && Number.isFinite(tokenExpSecs)) candidates.push(tokenExpSecs * 1000);
  return Math.min(...candidates);
}

export async function getSession(sessionId: string): Promise<RedisSession | null> {
  const raw = await redis.get(`session:${sessionId}`);
  if (!raw) return null;
  const session = JSON.parse(raw) as RedisSession & { authenticationVersion?: number };
  // Legacy sessions may originate from an MFA challenge. Never promote them on reconnect.
  if (session?.authenticationVersion !== 3 || !session.authorization || session.authorization.sub !== session.userId
    || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) return null;
  // 失効判定 (AppError) だけを「無効セッション」 として扱う。 DB 接続断などの
  // 基盤障害まで null にすると、 呼び出し側 (ws/handler の sessionIsActive) が
  // deleteSession してしまい、 一過性の障害が恒久ログアウトに化ける。
  try { await assertUserSessionCurrent(session.authorization); }
  catch (err) {
    if (err instanceof AppError) return null;
    throw err;
  }
  return session;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await redis.del(`session:${sessionId}`);
}

// ── User State ───────────────────────────────────────────────

export type UserState = "none" | "logged_in" | "session_expired";

export interface UserFullState {
  userId: string;
  sessionId: string;
  state: UserState;
  modules: string[];
  lastPingAt: number;
}

export async function setUserState(state: UserFullState): Promise<void> {
  const key = `ustate:${state.userId}`;
  await redis.set(key, JSON.stringify(state), "EX", SESSION_TTL_SECS);
}

export async function getUserState(userId: string): Promise<UserFullState | null> {
  const raw = await redis.get(`ustate:${userId}`);
  if (!raw) return null;
  return JSON.parse(raw) as UserFullState;
}

export async function updateUserStateField(userId: string, newState: UserState): Promise<void> {
  const current = await getUserState(userId);
  if (current) {
    current.state = newState;
    await setUserState(current);
  }
}

export async function updateLastPing(userId: string, ts: number): Promise<void> {
  const current = await getUserState(userId);
  if (current) {
    current.lastPingAt = ts;
    await setUserState(current);
  }
}

// ── Rate Limiting ────────────────────────────────────────────

// INCR と EXPIRE を 1 スクリプトに閉じ込め、 atomic に処理する。
// 旧実装は incr→(別往復)expire だったため、 count===1 の直後にプロセスが
// 落ちると TTL 無しキーが残り、 そのキーが恒久的にレート上限に張り付く隙があった。
const RATE_LIMIT_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return c
`;

export async function checkRateLimit(
  key: string, maxRequests: number, windowSecs: number,
): Promise<void> {
  const redisKey = `ratelimit:${key}`;
  const count = Number(
    await redis.eval(RATE_LIMIT_LUA, 1, redisKey, String(windowSecs)),
  );
  if (count > maxRequests) {
    throw new Error("Rate limit exceeded. Please try again later.");
  }
}

/** 数を足さずに、既に上限へ達しているかだけを見る (失敗だけを数える制限で使う)。 */
export async function isRateLimited(key: string, maxRequests: number): Promise<boolean> {
  const count = Number(await redis.get(`ratelimit:${key}`) ?? 0);
  return count >= maxRequests;
}

/** 判定せずに 1 回分だけ足す (失敗の記録)。 */
export async function recordRateLimitHit(key: string, windowSecs: number): Promise<void> {
  await redis.eval(RATE_LIMIT_LUA, 1, `ratelimit:${key}`, String(windowSecs));
}
