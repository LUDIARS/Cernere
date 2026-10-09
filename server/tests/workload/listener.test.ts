import { describe, expect, it, vi } from 'vitest';
import type uWS from 'uWebSockets.js';
vi.mock('../../src/redis.js', () => ({ checkRateLimit: vi.fn(async () => {}) }));
vi.mock('../../src/workload/store.js', () => ({ workloadStore: {} }));
const { workloadListenerConfig } = await import('../../src/http/workload-listener-config.js');
const { createWorkloadApp } = await import('../../src/http/workload-listener.js');

const full = { CERNERE_TLS_CERT_FILE: 'cert.pem', CERNERE_TLS_KEY_FILE: 'key.pem', CERNERE_WORKLOAD_TLS_PORT: '8443' };

describe('workload TLS listener config', () => {
  it('is disabled when nothing is configured, keeping the general listener plain', () => {
    expect(workloadListenerConfig({}, 8080)).toBeNull();
  });
  it('requires cert, key and port together', () => {
    for (const omitted of Object.keys(full)) {
      const env = { ...full, [omitted]: undefined };
      expect(() => workloadListenerConfig(env, 8080)).toThrow(new RegExp(`missing: ${omitted}`));
    }
    expect(() => workloadListenerConfig({ CERNERE_TLS_CERT_FILE: 'cert.pem' }, 8080)).toThrow();
    expect(() => workloadListenerConfig({ CERNERE_WORKLOAD_TLS_PORT: '8443' }, 8080)).toThrow();
  });
  it('rejects invalid ports and the general listener port', () => {
    for (const port of ['0', '65536', 'abc', '84.43', '-1']) {
      expect(() => workloadListenerConfig({ ...full, CERNERE_WORKLOAD_TLS_PORT: port }, 8080)).toThrow();
    }
    expect(() => workloadListenerConfig({ ...full, CERNERE_WORKLOAD_TLS_PORT: '8080' }, 8080)).toThrow(/differ from LISTEN_PORT/);
  });
  it('returns TLS files and a separate port when fully configured', () => {
    expect(workloadListenerConfig(full, 8080)).toEqual({
      tls: { cert_file_name: 'cert.pem', key_file_name: 'key.pem' }, port: 8443,
    });
  });
});

describe('workload TLS app', () => {
  function build() {
    const routes: Array<{ method: string; path: string; handler: (res: uWS.HttpResponse, req: uWS.HttpRequest) => unknown }> = [];
    const record = (method: string) => (path: string, handler: (res: uWS.HttpResponse, req: uWS.HttpRequest) => unknown) => {
      routes.push({ method, path, handler }); return app;
    };
    const app = { post: record('post'), any: record('any'), get: record('get'), ws: record('ws') } as unknown as uWS.TemplatedApp;
    const sslApp = vi.fn(() => app);
    const http = { readBody: vi.fn(async () => '{}'), jsonResponse: vi.fn(), getRemoteIp: () => '127.0.0.1',
      classifyError: () => ({ status: '400 Bad Request', message: 'Invalid workload request' }) };
    createWorkloadApp({ cert_file_name: 'cert.pem', key_file_name: 'key.pem' }, http, sslApp);
    return { routes, sslApp, http };
  }

  it('creates the SSLApp with only workload routes and a 404 fallback', () => {
    const f = build();
    expect(f.sslApp).toHaveBeenCalledWith({ cert_file_name: 'cert.pem', key_file_name: 'key.pem' });
    expect(f.routes.map(r => `${r.method} ${r.path}`)).toEqual([
      'post /api/workload/token', 'post /api/workload/introspect', 'any /*',
    ]);
  });
  it('treats requests on the SSLApp as TLS (no 403 transport rejection)', async () => {
    const f = build();
    const req = { getHeader: (name: string) => name === 'content-type' ? 'text/plain' : '' } as uWS.HttpRequest;
    await f.routes[0].handler({} as uWS.HttpResponse, req);
    expect(f.http.jsonResponse.mock.calls[0][1]).toBe('400 Bad Request');
  });
});
