/**
 * 認証ヘルパー関数
 */

import type { Context } from "hono";

export function getUserId(c: Context): string | null {
  const ctxId = c.get("userId" as never) as string | undefined;
  if (ctxId && ctxId !== "anonymous") return ctxId;
  return c.req.header("X-User-Id") || null;
}

export function getUserRole(c: Context): string {
  return (c.get("userRole" as never) as string) || "general";
}
