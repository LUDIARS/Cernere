/**
 * @cernere/service-adapter — Hono ミドルウェア
 *
 * service_token を検証し、コンテキストにユーザー情報を設定する。
 * revoke されたユーザーを自動拒否する。
 */

import type { CernereServiceAdapter } from "./adapter.js";

interface MiddlewareConfig {
  /** CernereServiceAdapter インスタンス */
  adapter: CernereServiceAdapter;
  /** JWT シークレット (service_token 検証用) */
  jwtSecret: string;
  /** 開発モード: X-User-Id ヘッダーフォールバック */
  isDev?: boolean;
}

interface ServiceTokenPayload {
  sub: string;
  name: string;
  email: string | null;
  role: string;
  iat: number;
  exp: number;
  iss: string;
}

/**
 * service_token を検証する Hono ミドルウェアファクトリ
 *
 * ```typescript
 * import { createServiceAuthMiddleware } from "@cernere/service-adapter";
 *
 * app.use("*", createServiceAuthMiddleware({
 *   adapter,
 *   jwtSecret: process.env.SERVICE_JWT_SECRET!,
 * }));
 * ```
 */
export function createServiceAuthMiddleware(config: MiddlewareConfig) {
  return async (c: {
    req: { header: (name: string) => string | undefined };
    set: (key: string, value: unknown) => void;
    json: (data: unknown, status?: number) => Response;
  }, next: () => Promise<void>) => {
    const authHeader = c.req.header("Authorization");

    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);

      try {
        const payload = verifyServiceToken(token, config.jwtSecret);

        // revoke チェック
        if (config.adapter.isRevoked(payload.sub)) {
          return c.json({ error: "User session revoked" }, 401);
        }

        // 有効期限チェック
        if (payload.exp < Math.floor(Date.now() / 1000)) {
          return c.json({ error: "Token expired" }, 401);
        }

        c.set("userId", payload.sub);
        c.set("userRole", payload.role);
        c.set("userName", payload.name);
        c.set("userEmail", payload.email);
        return next();
      } catch {
        return c.json({ error: "Invalid service token" }, 401);
      }
    }

    // 開発モード: ヘッダーフォールバック
    if (config.isDev) {
      const devUserId = c.req.header("X-User-Id");
      const devRole = c.req.header("X-User-Role") || "general";
      if (devUserId) {
        c.set("userId", devUserId);
        c.set("userRole", devRole);
        return next();
      }
    }

    return c.json({ error: "No token provided" }, 401);
  };
}

/** service_token (HS256 JWT) を検証 */
function verifyServiceToken(token: string, secret: string): ServiceTokenPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");

  const [headerB64, payloadB64, signatureB64] = parts;
  const data = `${headerB64}.${payloadB64}`;

  // 署名検証
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("node:crypto");
  const expected = (crypto as { createHmac: (alg: string, key: string) => { update: (data: string) => { digest: (enc: string) => string } } })
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64url");

  if (expected !== signatureB64) {
    throw new Error("Invalid signature");
  }

  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as ServiceTokenPayload;
  return payload;
}
