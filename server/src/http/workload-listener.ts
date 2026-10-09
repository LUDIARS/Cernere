import uWS from 'uWebSockets.js';
import { registerWorkloadRoutes, type WorkloadHttpHelpers } from './workload-routes.js';
import type { WorkloadListenerConfig } from './workload-listener-config.js';
import { displayHost } from './listen-host.js';

/**
 * workload 専用の TLS app。 SSLApp を作るのはこのモジュールだけで、
 * 載せるのは workload ルートと 404 のみ (一般認証 API・WS は載せない)。
 */
export function createWorkloadApp(
  options: uWS.AppOptions, http: WorkloadHttpHelpers, sslApp: (o: uWS.AppOptions) => uWS.TemplatedApp = uWS.SSLApp,
): uWS.TemplatedApp {
  const app = sslApp(options);
  // tls=true is derived from this SSLApp alone; the plain app registers the same routes with tls=false.
  registerWorkloadRoutes(app, http, true);
  app.any('/*', (res) => {
    http.jsonResponse(res, '404 Not Found', { error: 'Not found' }, [], { 'Cache-Control': 'no-store' });
  });
  return app;
}

/** host は一般待受と同じ LISTEN_HOST (null = 全インターフェース)。 */
export function startWorkloadListener(
  config: WorkloadListenerConfig, http: WorkloadHttpHelpers, host: string | null = null,
): uWS.TemplatedApp {
  const app = createWorkloadApp(config.tls, http);
  const onListen = (listenSocket: uWS.us_listen_socket | false) => {
    if (listenSocket) {
      console.log(`[server] Workload TLS: https://${displayHost(host)}:${config.port}/api/workload/*`);
    } else {
      console.error(`[server] Failed to listen for workload TLS on port ${config.port}`);
      process.exit(1);
    }
  };
  if (host) app.listen(host, config.port, onListen);
  else app.listen(config.port, onListen);
  return app;
}
