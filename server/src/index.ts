/**
 * Cernere Server — エントリポイント (uWebSockets.js)
 */

import { assertRuntimeSecrets, config } from "./config.js";
import { createApp, httpHelpers } from "./app.js";
import { workloadListenerConfig } from "./http/workload-listener-config.js";
import { startWorkloadListener } from "./http/workload-listener.js";
import { displayHost, readListenHost } from "./http/listen-host.js";
import { redis } from "./redis.js";
import { runMigrations } from "./db/migrate.js";
import { initOidcKeys } from "./auth/oidc-keys.js";
import { purgeExpiredFaceConsents } from "./identity/face-consent-store.js";
import { purgeExpiredFaceRevocations } from "./identity/face-revocation-store.js";

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
  // workload TLS の片側設定も I/O 前に構成エラーとして止める。
  const workloadListener = workloadListenerConfig(process.env, config.listenPort);
  // 未設定なら全インターフェース。 本社のテスト用 Cernere は 127.0.0.1 (spec/setup/hq-test-instance.md)。
  const listenHost = readListenHost(process.env);

  await runMigrations();
  await purgeExpiredFaceConsents();
  await purgeExpiredFaceRevocations();
  await redis.connect();
  await initOidcKeys();

  const app = createApp();

  const onListen = (listenSocket: unknown) => {
    if (listenSocket) {
      const host = displayHost(listenHost);
      console.log(`[server] Listening on http://${host}:${config.listenPort}`);
      console.log(`[server] WebSocket: ws://${host}:${config.listenPort}/auth`);
      console.log(`[server] Frontend URL: ${config.frontendUrl}`);
    } else {
      console.error(`[server] Failed to listen on port ${config.listenPort}`);
      process.exit(1);
    }
  };
  if (listenHost) app.listen(listenHost, config.listenPort, onListen);
  else app.listen(config.listenPort, onListen);
  if (workloadListener) startWorkloadListener(workloadListener, httpHelpers, listenHost);
}

main().catch((err) => {
  console.error("[server] Fatal error:", err);
  process.exit(1);
});
