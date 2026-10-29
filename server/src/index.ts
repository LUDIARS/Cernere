/**
 * Cernere Server — エントリポイント (uWebSockets.js)
 */

import { assertRuntimeSecrets, config } from "./config.js";
import { createApp, httpHelpers } from "./app.js";
import { workloadListenerConfig } from "./http/workload-listener-config.js";
import { startWorkloadListener } from "./http/workload-listener.js";
import { displayHost, readListenHosts } from "./http/listen-host.js";
import { redis } from "./redis.js";
import { runMigrations } from "./db/migrate.js";
import { initOidcKeys } from "./auth/oidc-keys.js";
import { startOutboxWorker } from "./notify/outbox-worker.js";
import { startAccessRequestDigest } from "./notify/access-request-digest.js";
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
  // 未設定なら全インターフェース。 本社のテスト用 Cernere は 127.0.0.1 (spec/setup/hq-test-instance.md)、
  // 外部公開する本番はループバック + tailnet (spec/setup/public-exposure.md)。
  const listenHosts = readListenHosts(process.env);
  // 本番で未設定だと全インターフェースで待ち受け、SG の開け忘れ 1 つで Cloudflare を素通りされる。
  if (config.isProduction && !listenHosts) {
    throw new Error("LISTEN_HOST is required in production (spec/setup/public-exposure.md)");
  }

  await runMigrations();
  await purgeExpiredFaceConsents();
  await purgeExpiredFaceRevocations();
  await redis.connect();
  await initOidcKeys();

  const app = createApp();

  const onListen = (listenHost: string | null) => (listenSocket: unknown) => {
    if (listenSocket) {
      const host = displayHost(listenHost);
      console.log(`[server] Listening on http://${host}:${config.listenPort}`);
      console.log(`[server] WebSocket: ws://${host}:${config.listenPort}/auth`);
      console.log(`[server] Frontend URL: ${config.frontendUrl}`);
    } else {
      console.error(`[server] Failed to listen on ${displayHost(listenHost)}:${config.listenPort}`);
      process.exit(1);
    }
  };
  if (listenHosts) for (const host of listenHosts) app.listen(host, config.listenPort, onListen(host));
  else app.listen(config.listenPort, onListen(null));
  if (workloadListener) startWorkloadListener(workloadListener, httpHelpers, listenHosts);
  // ログイン通知の配送 (SPEC-LOGIN-ALERT)。配送の失敗は認証処理に影響しない。
  startOutboxWorker();
  // 審査待ちの利用申請を admin へまとめて知らせる (許可制 案 A)。
  startAccessRequestDigest();
}

// 1 リクエストの取りこぼした reject でプロセスごと落とさない (Node の既定は unhandledRejection で終了)。
// 原因は記録して直す。起動前の失敗は下の main().catch が拾うので、ここでは止めない。
process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled rejection (request kept the process alive):", reason);
});

main().catch((err) => {
  console.error("[server] Fatal error:", err);
  process.exit(1);
});
