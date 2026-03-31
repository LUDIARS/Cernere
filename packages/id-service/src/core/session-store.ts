/**
 * セッションストア — Redis優先、DBフォールバック
 */

import { v4 as uuidv4 } from "uuid";
import type { IdSessionRepo, GetRedis } from "./types.js";

export interface SessionData {
  id: string;
  userId: string;
  refreshToken: string;
  expiresAt: Date;
  createdAt: Date;
}

const SESSION_PREFIX = "session:";
const REFRESH_INDEX_PREFIX = "refresh:";

function computeTtlSeconds(expiresAt: Date): number {
  const diffMs = expiresAt.getTime() - Date.now();
  return Math.max(Math.floor(diffMs / 1000), 60);
}

export interface SessionStore {
  createSession(userId: string, refreshToken: string, expiresAt: Date): Promise<SessionData>;
  findByRefreshToken(refreshToken: string): Promise<SessionData | null>;
  rotateRefreshToken(sessionId: string, oldRefreshToken: string, newRefreshToken: string, expiresAt: Date): Promise<void>;
  deleteByRefreshToken(refreshToken: string): Promise<void>;
  deleteById(sessionId: string): Promise<void>;
}

export function createSessionStore(
  sessionRepo: IdSessionRepo,
  getRedis: GetRedis,
): SessionStore {
  return {
    async createSession(userId, refreshToken, expiresAt) {
      const sessionId = uuidv4();
      const now = new Date();
      const session: SessionData = { id: sessionId, userId, refreshToken, expiresAt, createdAt: now };

      const redis = getRedis();
      if (redis) {
        try {
          const data = JSON.stringify({
            id: sessionId, userId, refreshToken,
            expiresAt: expiresAt.toISOString(),
            createdAt: now.toISOString(),
          });
          await redis
            .multi()
            .set(`${SESSION_PREFIX}${sessionId}`, data, "EX", computeTtlSeconds(expiresAt))
            .set(`${REFRESH_INDEX_PREFIX}${refreshToken}`, sessionId, "EX", computeTtlSeconds(expiresAt))
            .exec();
        } catch (err) {
          console.error("[session:redis] 作成失敗、DBフォールバック:", err);
          await sessionRepo.create({ id: sessionId, userId, refreshToken, expiresAt, createdAt: now });
        }
      } else {
        await sessionRepo.create({ id: sessionId, userId, refreshToken, expiresAt, createdAt: now });
      }
      return session;
    },

    async findByRefreshToken(refreshToken) {
      const redis = getRedis();
      if (redis) {
        try {
          const sessionId = await redis.get(`${REFRESH_INDEX_PREFIX}${refreshToken}`);
          if (!sessionId) return null;
          const data = await redis.get(`${SESSION_PREFIX}${sessionId}`);
          if (!data) return null;
          const parsed = JSON.parse(data);
          return { ...parsed, expiresAt: new Date(parsed.expiresAt), createdAt: new Date(parsed.createdAt) };
        } catch (err) {
          console.error("[session:redis] 検索失敗、DBフォールバック:", err);
        }
      }
      const dbSession = await sessionRepo.findByRefreshToken(refreshToken);
      if (!dbSession) return null;
      return {
        id: dbSession.id, userId: dbSession.userId, refreshToken: dbSession.refreshToken,
        expiresAt: new Date(dbSession.expiresAt), createdAt: new Date(dbSession.createdAt),
      };
    },

    async rotateRefreshToken(sessionId, oldRefreshToken, newRefreshToken, expiresAt) {
      const redis = getRedis();
      if (redis) {
        try {
          const data = await redis.get(`${SESSION_PREFIX}${sessionId}`);
          if (data) {
            const parsed = JSON.parse(data);
            parsed.refreshToken = newRefreshToken;
            parsed.expiresAt = expiresAt.toISOString();
            await redis
              .multi()
              .set(`${SESSION_PREFIX}${sessionId}`, JSON.stringify(parsed), "EX", computeTtlSeconds(expiresAt))
              .del(`${REFRESH_INDEX_PREFIX}${oldRefreshToken}`)
              .set(`${REFRESH_INDEX_PREFIX}${newRefreshToken}`, sessionId, "EX", computeTtlSeconds(expiresAt))
              .exec();
            return;
          }
        } catch (err) {
          console.error("[session:redis] ローテーション失敗、DBフォールバック:", err);
        }
      }
      await sessionRepo.updateRefreshToken(sessionId, newRefreshToken);
    },

    async deleteByRefreshToken(refreshToken) {
      const redis = getRedis();
      if (redis) {
        try {
          const sessionId = await redis.get(`${REFRESH_INDEX_PREFIX}${refreshToken}`);
          if (sessionId) {
            await redis.multi()
              .del(`${SESSION_PREFIX}${sessionId}`)
              .del(`${REFRESH_INDEX_PREFIX}${refreshToken}`)
              .exec();
            return;
          }
        } catch (err) {
          console.error("[session:redis] 削除失敗、DBフォールバック:", err);
        }
      }
      await sessionRepo.deleteByRefreshToken(refreshToken);
    },

    async deleteById(sessionId) {
      const redis = getRedis();
      if (redis) {
        try {
          const data = await redis.get(`${SESSION_PREFIX}${sessionId}`);
          if (data) {
            const parsed = JSON.parse(data);
            await redis.multi()
              .del(`${SESSION_PREFIX}${sessionId}`)
              .del(`${REFRESH_INDEX_PREFIX}${parsed.refreshToken}`)
              .exec();
            return;
          }
        } catch (err) {
          console.error("[session:redis] 削除(ID)失敗、DBフォールバック:", err);
        }
      }
      await sessionRepo.deleteById(sessionId);
    },
  };
}
