/**
 * Redis クライアント (ioredis)
 *
 * セッション管理、ユーザーステート、レートリミット
 */

import Redis from "ioredis";
import { config } from "./config.js";

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
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
}

export async function putSession(session: RedisSession): Promise<void> {
  const key = `session:${session.id}`;
  await redis.set(key, JSON.stringify(session), "EX", SESSION_TTL_SECS);
}

export async function getSession(sessionId: string): Promise<RedisSession | null> {
  const raw = await redis.get(`session:${sessionId}`);
  if (!raw) return null;
  return JSON.parse(raw) as RedisSession;
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

export async function checkRateLimit(
  key: string, maxRequests: number, windowSecs: number,
): Promise<void> {
  const redisKey = `ratelimit:${key}`;
  const count = await redis.incr(redisKey);
  if (count === 1) {
    await redis.expire(redisKey, windowSecs);
  }
  if (count > maxRequests) {
    throw new Error("Rate limit exceeded. Please try again later.");
  }
}
