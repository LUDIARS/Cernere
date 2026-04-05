/**
 * Cernere Server — エントリポイント
 *
 * Hono + Node.js HTTP サーバー
 */

import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { redis } from "./redis.js";

async function main() {
  console.log("=== Cernere Server (TypeScript) ===");
  console.log(`  Environment: ${config.isProduction ? "production" : "development"}`);

  // Redis 接続
  await redis.connect();

  // アプリ作成
  const app = createApp();

  // サーバー起動
  const port = config.listenPort;
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[server] Listening on http://localhost:${info.port}`);
    console.log(`[server] Frontend URL: ${config.frontendUrl}`);
  });
}

main().catch((err) => {
  console.error("[server] Fatal error:", err);
  process.exit(1);
});
