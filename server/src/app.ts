/**
 * Hono アプリケーション — ルート定義
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { createNodeWebSocket } from "@hono/node-ws";
import { config } from "./config.js";
import { AppError } from "./error.js";
import { authRoutes } from "./auth/routes.js";
import { googleOAuthRoutes } from "./auth/oauth-google.js";
import { githubOAuthRoutes } from "./auth/oauth-github.js";
import {
  resolveWsAuth,
  createAuthenticatedWsHandler,
  createGuestWsHandler,
} from "./ws/handler.js";

export function createApp() {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // ─── Global Error Handler ─────────────────────────────────
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.message }, err.statusCode as 400);
    }
    console.error(`[server] Unhandled error: ${c.req.method} ${c.req.path}`, err);
    return c.json({ error: "Internal server error" }, 500);
  });

  // ─── CORS ─────────────────────────────────────────────────
  app.use("*", cors({
    origin: config.frontendUrl,
    credentials: true,
  }));

  // ─── Auth REST routes ─────────────────────────────────────
  app.route("/api/auth", authRoutes);

  // ─── OAuth routes ─────────────────────────────────────────
  app.route("/auth", googleOAuthRoutes);
  app.route("/auth", githubOAuthRoutes);

  // ─── Auth code exchange ───────────────────────────────────
  app.post("/api/auth/exchange", async (c) => {
    const { code } = await c.req.json<{ code: string }>();
    if (!code) throw AppError.badRequest("code is required");

    const { redis } = await import("./redis.js");
    const raw = await redis.get(`authcode:${code}`);
    if (!raw) throw AppError.unauthorized("Invalid or expired auth code");
    await redis.del(`authcode:${code}`);

    return c.json(JSON.parse(raw));
  });

  // ─── WebSocket: /auth (認証済み or ゲスト) ─────────────────
  app.get("/auth",
    upgradeWebSocket(async (c) => {
      const token = c.req.query("token");
      const sessionId = c.req.query("session_id");

      const auth = await resolveWsAuth(token, sessionId);

      if (auth) {
        return createAuthenticatedWsHandler(auth.userId, auth.sessionId);
      }

      // ゲストセッション
      return createGuestWsHandler();
    }),
  );

  // ─── Health check ─────────────────────────────────────────
  app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return { app, injectWebSocket };
}
