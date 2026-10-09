import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// createApp は TLS 設定の有無にかかわらず平文 uWS.App を作り、既存ルートを全て持つ。
type Handler = (...args: unknown[]) => unknown;
const uws = vi.hoisted(() => ({
  app: vi.fn(), ssl: vi.fn(),
  routes: [] as Array<{ method: string; path: string; handler: unknown }>,
}));
vi.mock('uWebSockets.js', () => {
  const make = () => {
    const app: Record<string, unknown> = {};
    for (const method of ['get', 'post', 'put', 'del', 'patch', 'options', 'any', 'ws']) {
      app[method] = (path: string, handler: unknown) => { uws.routes.push({ method, path, handler }); return app; };
    }
    app.listen = () => app;
    return app;
  };
  uws.app.mockImplementation(make);
  uws.ssl.mockImplementation(make);
  return { default: { App: uws.app, SSLApp: uws.ssl } };
});
vi.mock('../../src/workload/store.js', () => ({ workloadStore: {} }));

const tlsEnv = { CERNERE_TLS_CERT_FILE: 'cert.pem', CERNERE_TLS_KEY_FILE: 'key.pem', CERNERE_WORKLOAD_TLS_PORT: '8443' };
const saved: Record<string, string | undefined> = {};

function fakeRes() {
  const out = { status: '', headers: {} as Record<string, string>, body: '' };
  const res = {
    cork(fn: () => void) { fn(); return res; },
    writeStatus(s: string) { out.status = s; return res; },
    writeHeader(k: string, v: string) { out.headers[k] = v; return res; },
    end(b = '') { out.body = b; return res; },
    onAborted() { return res; },
  };
  return { res, out };
}
const route = (method: string, path: string) => uws.routes.find(r => r.method === method && r.path === path);

describe('general app stays plain HTTP when workload TLS is configured', () => {
  let config: { frontendUrl: string };
  beforeAll(async () => {
    for (const [k, v] of Object.entries(tlsEnv)) { saved[k] = process.env[k]; process.env[k] = v; }
    const { createApp } = await import('../../src/app.js');
    ({ config } = await import('../../src/config.js'));
    createApp();
  }, 60_000); // app.ts pulls in every route module; cold import is slow under the parallel full suite.
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('creates uWS.App and never SSLApp', () => {
    expect(uws.app).toHaveBeenCalledTimes(1);
    expect(uws.ssl).not.toHaveBeenCalled();
  });
  it('keeps /auth and the other WebSocket and REST paths on the plain app', () => {
    for (const path of ['/auth', '/ws/project', '/auth/composite-ws']) expect(route('ws', path)).toBeDefined();
    for (const [method, path] of [['post', '/api/auth/:action'], ['get', '/health'], ['get', '/auth/github/callback'],
      ['get', '/.well-known/openid-configuration'], ['options', '/*'], ['any', '/*']]) {
      expect(route(method, path)).toBeDefined();
    }
  });
  it('keeps the CORS preflight unchanged', () => {
    const { res, out } = fakeRes();
    (route('options', '/*')!.handler as Handler)(res);
    expect(out.status).toBe('204 No Content');
    expect(out.headers['Access-Control-Allow-Origin']).toBe(config.frontendUrl);
    expect(out.headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(out.headers['Access-Control-Allow-Methods']).toBe('GET, POST, PUT, DELETE, OPTIONS');
  });
  it('rejects workload routes on the plain app with 403', async () => {
    for (const path of ['/api/workload/token', '/api/workload/introspect']) {
      const { res, out } = fakeRes();
      const req = { getHeader: () => 'application/json' };
      await (route('post', path)!.handler as Handler)(res, req);
      expect(out.status).toBe('403 Forbidden');
      expect(JSON.parse(out.body)).toEqual({ error: 'Workload endpoints require TLS' });
    }
  });
});
