/**
 * Cernere Server — エントリポイント
 */

import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { redis } from "./redis.js";

async function main() {
  console.log("=== Cernere Server (TypeScript) ===");
  console.log(`  Environment: ${config.isProduction ? "production" : "development"}`);

  await redis.connect();

  const { app, injectWebSocket } = createApp();

  const server = serve({ fetch: app.fetch, port: config.listenPort }, (info) => {
    console.log(`[server] Listening on http://localhost:${info.port}`);
    console.log(`[server] Frontend URL: ${config.frontendUrl}`);
  });

  injectWebSocket(server);
  console.log("[server] WebSocket handler injected");
}

main().catch((err) => {
  console.error("[server] Fatal error:", err);
  process.exit(1);
});
