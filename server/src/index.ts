/**
 * Cernere Server — エントリポイント (uWebSockets.js)
 */

import { assertRuntimeSecrets, config } from "./config.js";
import { createApp } from "./app.js";
import { redis } from "./redis.js";
import { runMigrations } from "./db/migrate.js";
import { initOidcKeys } from "./auth/oidc-keys.js";

async function main() {
  console.log("=== Cernere Server (uWebSockets.js) ===");
  const envLabel = config.isProduction
    ? "production"
    : config.isDevelopment
      ? "development (verbose dev logging on)"
      : "unknown";
  console.log(`  Environment: ${envLabel}`);

  // 遅延評価にした secret の起動時 fail-fast。 listen 後に初回ログインで落ちる、
  // という壊れ方を避けるため、 I/O を始める前に検査する。
  assertRuntimeSecrets();

  await runMigrations();
  await redis.connect();
  await initOidcKeys();

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
