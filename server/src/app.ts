/**
 * Hono アプリケーション — ルート定義
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config.js";
import { AppError } from "./error.js";
import { authRoutes } from "./auth/routes.js";

export function createApp() {
  const app = new Hono();

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

  // ─── Auth routes ──────────────────────────────────────────
  app.route("/api/auth", authRoutes);

  // ─── Health check ─────────────────────────────────────────
  app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return app;
}
