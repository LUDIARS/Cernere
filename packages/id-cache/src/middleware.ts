/**
 * Id Cache — Hono ミドルウェア
 *
 * Authorization ヘッダーの JWT を検証し、
 * ユーザー情報をキャッシュ経由で解決して Context にセットする。
 *
 * キャッシュがない場合 (idCache === null) は
 * jwtSecret でのローカル検証にフォールバックする。
 */

import { createMiddleware } from "hono/factory";
import jwt from "jsonwebtoken";
import type { IdCacheClient } from "./cache.js";

export interface IdCacheMiddlewareOptions {
  /** IdCacheClient インスタンス (null = キャッシュなし、ローカル検証のみ) */
  idCache: IdCacheClient | null;

  /** JWT シークレット (キャッシュなし時のフォールバック検証用) */
  jwtSecret?: string;

  /** 開発環境フラグ (true の場合、X-User-Id ヘッダーフォールバック有効) */
  isDev?: boolean;
}

/**
 * ユーザーコンテキスト抽出ミドルウェア
 *
 * c.set("userId"), c.set("userRole") をセットする。
 * キャッシュがある場合はユーザー情報もキャッシュから取得する。
 */
export function createIdCacheMiddleware(options: IdCacheMiddlewareOptions) {
  const { idCache, jwtSecret, isDev = false } = options;

  return createMiddleware(async (c, next) => {
    const authHeader = c.req.header("Authorization");

    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);

      if (idCache) {
        // キャッシュ経由で解決
        const user = await idCache.resolveUser(token);
        if (user) {
          c.set("userId" as never, user.id as never);
          c.set("userRole" as never, user.role as never);
          c.set("user" as never, user as never);
        } else {
          c.set("userId" as never, "anonymous" as never);
          c.set("userRole" as never, "general" as never);
        }
      } else if (jwtSecret) {
        // キャッシュなし: ローカル JWT 検証
        try {
          const payload = jwt.verify(token, jwtSecret) as { userId: string; role: string };
          c.set("userId" as never, payload.userId as never);
          c.set("userRole" as never, payload.role as never);
        } catch {
          c.set("userId" as never, "anonymous" as never);
          c.set("userRole" as never, "general" as never);
        }
      } else {
        c.set("userId" as never, "anonymous" as never);
        c.set("userRole" as never, "general" as never);
      }
    } else if (isDev) {
      // 開発環境: ヘッダーフォールバック
      const userId = c.req.header("X-User-Id") || "anonymous";
      const role = c.req.header("X-User-Role") || "general";
      c.set("userId" as never, userId as never);
      c.set("userRole" as never, role as never);
    } else {
      c.set("userId" as never, "anonymous" as never);
      c.set("userRole" as never, "general" as never);
    }

    await next();
  });
}
