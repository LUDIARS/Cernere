/**
 * Id Cache — ユーザー情報キャッシュクライアント
 *
 * Id Service API の結果をインメモリ (TTL付き) にキャッシュする。
 * Redis が渡された場合は Redis をキャッシュバックエンドに使う。
 */

import jwt from "jsonwebtoken";

// ─── Types ─────────────────────────────────────────────────

export interface CachedUser {
  id: string;
  name: string;
  email: string;
  role: string;
  [key: string]: unknown;
}

export interface IdCacheConfig {
  /** Id Service の URL (例: "http://localhost:8079") */
  idServiceUrl: string;

  /** JWT シークレット (ローカル検証用。指定しない場合は Id Service に /verify を投げる) */
  jwtSecret?: string;

  /** キャッシュ TTL (秒, デフォルト: 300 = 5分) */
  cacheTtlSeconds?: number;

  /** 最大キャッシュ数 (デフォルト: 10000) */
  maxCacheSize?: number;
}

interface CacheEntry {
  user: CachedUser;
  expiresAt: number;
}

// ─── Client ────────────────────────────────────────────────

export interface IdCacheClient {
  /** JWT トークンからユーザーを解決 (キャッシュ優先) */
  resolveUser(token: string): Promise<CachedUser | null>;

  /** キャッシュを強制的にクリア */
  invalidate(userId: string): void;

  /** 全キャッシュクリア */
  clear(): void;

  /** キャッシュ統計 */
  stats(): { size: number; hits: number; misses: number };
}

export function createIdCache(config: IdCacheConfig): IdCacheClient {
  const {
    idServiceUrl,
    jwtSecret,
    cacheTtlSeconds = 300,
    maxCacheSize = 10000,
  } = config;

  const cache = new Map<string, CacheEntry>();
  let hits = 0;
  let misses = 0;

  function evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of cache.entries()) {
      if (entry.expiresAt < now) cache.delete(key);
    }
  }

  function evictIfFull(): void {
    if (cache.size < maxCacheSize) return;
    // LRU 的に古いものから削除 (Map は挿入順)
    const deleteCount = Math.floor(maxCacheSize * 0.2);
    let count = 0;
    for (const key of cache.keys()) {
      if (count >= deleteCount) break;
      cache.delete(key);
      count++;
    }
  }

  async function fetchFromIdService(token: string): Promise<CachedUser | null> {
    try {
      const res = await fetch(`${idServiceUrl}/api/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });

      if (!res.ok) return null;

      const data = (await res.json()) as { valid: boolean; user?: CachedUser };
      if (!data.valid || !data.user) return null;

      return data.user;
    } catch {
      return null;
    }
  }

  function decodeLocally(token: string): { userId: string; role: string } | null {
    if (!jwtSecret) return null;
    try {
      return jwt.verify(token, jwtSecret) as { userId: string; role: string };
    } catch {
      return null;
    }
  }

  return {
    async resolveUser(token: string): Promise<CachedUser | null> {
      // 1. ローカル JWT 検証 (jwtSecret がある場合)
      const payload = decodeLocally(token);
      if (payload) {
        const cached = cache.get(payload.userId);
        if (cached && cached.expiresAt > Date.now()) {
          hits++;
          return cached.user;
        }
      }

      misses++;

      // 2. Id Service に問い合わせ
      const user = await fetchFromIdService(token);
      if (!user) return null;

      // 3. キャッシュに保存
      evictExpired();
      evictIfFull();
      cache.set(user.id, {
        user,
        expiresAt: Date.now() + cacheTtlSeconds * 1000,
      });

      return user;
    },

    invalidate(userId: string): void {
      cache.delete(userId);
    },

    clear(): void {
      cache.clear();
      hits = 0;
      misses = 0;
    },

    stats() {
      return { size: cache.size, hits, misses };
    },
  };
}
