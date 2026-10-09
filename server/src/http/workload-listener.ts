import uWS from 'uWebSockets.js';
import { registerWorkloadRoutes, type WorkloadHttpHelpers } from './workload-routes.js';
import type { WorkloadListenerConfig } from './workload-listener-config.js';

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

export function startWorkloadListener(config: WorkloadListenerConfig, http: WorkloadHttpHelpers): uWS.TemplatedApp {
  const app = createWorkloadApp(config.tls, http);
  app.listen(config.port, (listenSocket) => {
    if (listenSocket) {
      console.log(`[server] Workload TLS: https://localhost:${config.port}/api/workload/*`);
    } else {
      console.error(`[server] Failed to listen for workload TLS on port ${config.port}`);
      process.exit(1);
    }
  });
  return app;
}
