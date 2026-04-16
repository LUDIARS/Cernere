/**
 * User project data の Redis キャッシュ層。
 *
 * `project_data_{key}` テーブルへの読み取りは頻度が高い (ダッシュボード表示毎)
 * ため、ユーザー単位でキャッシュする。書き込み系 (setUserData / setModuleOptout /
 * deleteUserColumns) はその都度 invalidate する。
 */

import { redis } from "../redis.js";

const CACHE_TTL_SECS = 300; // 5 min
const KEY_PREFIX = "project_data";

function cacheKey(userId: string, projectKey: string): string {
  return `${KEY_PREFIX}:${userId}:${projectKey}`;
}

export async function getCached<T>(userId: string, projectKey: string): Promise<T | null> {
  const raw = await redis.get(cacheKey(userId, projectKey));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setCached<T>(userId: string, projectKey: string, value: T): Promise<void> {
  await redis.set(cacheKey(userId, projectKey), JSON.stringify(value), "EX", CACHE_TTL_SECS);
}

export async function invalidate(userId: string, projectKey: string): Promise<void> {
  await redis.del(cacheKey(userId, projectKey));
}

/** 特定プロジェクトの全ユーザー分キャッシュを破棄 (スキーマ更新時等) */
export async function invalidateProject(projectKey: string): Promise<void> {
  const pattern = `${KEY_PREFIX}:*:${projectKey}`;
  const stream = redis.scanStream({ match: pattern, count: 200 });
  const keys: string[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: string[]) => {
      keys.push(...chunk);
    });
    stream.on("end", () => resolve());
    stream.on("error", (err) => reject(err));
  });
  if (keys.length > 0) await redis.del(...keys);
}
