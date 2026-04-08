/**
 * Cernere Server — エントリポイント (uWebSockets.js)
 */

import { config } from "./config.js";
import { createApp } from "./app.js";
import { redis } from "./redis.js";
import { runMigrations } from "./db/migrate.js";

async function main() {
  console.log("=== Cernere Server (uWebSockets.js) ===");
  console.log(`  Environment: ${config.isProduction ? "production" : "development"}`);

  await runMigrations();
  await redis.connect();

  const app = createApp();

  app.listen(config.listenPort, (listenSocket) => {
    if (listenSocket) {
      console.log(`[server] Listening on http://localhost:${config.listenPort}`);
      console.log(`[server] WebSocket: ws://localhost:${config.listenPort}/auth`);
      console.log(`[server] Frontend URL: ${config.frontendUrl}`);
    } else {
      console.error(`[server] Failed to listen on port ${config.listenPort}`);
      process.exit(1);
    }
  });
}

main().catch((err) => {
  console.error("[server] Fatal error:", err);
  process.exit(1);
});
