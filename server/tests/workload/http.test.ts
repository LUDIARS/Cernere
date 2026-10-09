import { describe, expect, it, vi } from 'vitest';
import type uWS from 'uWebSockets.js';
vi.mock('../../src/redis.js', () => ({ checkRateLimit: vi.fn() }));
vi.mock('../../src/workload/store.js', () => ({ workloadStore: {} }));
const { registerWorkloadRoutes } = await import('../../src/http/workload-routes.js');

function setup(tls: boolean, contentType = 'application/json') {
  const routes = new Map<string, (res: uWS.HttpResponse, req: uWS.HttpRequest) => Promise<void>>();
  const app = { post: (path: string, handler: (res: uWS.HttpResponse, req: uWS.HttpRequest) => Promise<void>) => { routes.set(path, handler); } };
  const http = { readBody: vi.fn(async () => '{}'), jsonResponse: vi.fn(), getRemoteIp: () => '127.0.0.1',
    classifyError: () => ({ status: '400 Bad Request', message: 'Invalid workload request' }) };
  const authority = { issue: vi.fn(async () => ({ access_token: 'opaque' })), introspect: vi.fn(async () => ({ active: false })) };
  const limit = vi.fn(async () => {});
  registerWorkloadRoutes(app as unknown as uWS.TemplatedApp, http, tls, authority, limit);
  const req = { getHeader: (name: string) => name === 'content-type' ? contentType : 'https' } as uWS.HttpRequest;
  const res = {} as uWS.HttpResponse;
  return { http, authority, limit, call: (path = '/api/workload/token') => routes.get(path)!(res, req) };
}

describe('workload HTTPS boundary', () => {
  it('rejects HTTP even with a spoofed forwarded proto', async () => {
    const f = setup(false); await f.call();
    expect(f.http.jsonResponse.mock.calls[0][1]).toBe('403 Forbidden');
    expect(f.authority.issue).not.toHaveBeenCalled();
    expect(f.http.readBody).not.toHaveBeenCalled();
  });
  it('requires JSON, bounds body bytes, limits requests and marks responses no-store', async () => {
    const rejected = setup(true, 'text/plain'); await rejected.call();
    expect(rejected.authority.issue).not.toHaveBeenCalled();
    const f = setup(true); await f.call();
    expect(f.http.readBody).toHaveBeenCalledWith(expect.anything(), 16384, expect.any(Function));
    expect(f.limit).toHaveBeenCalledWith('workload:token:127.0.0.1', 120, 60);
    expect(f.http.jsonResponse.mock.calls[0][4]).toMatchObject({ 'Cache-Control': 'no-store' });
  });
  it('does not disclose DB errors or fallback on authority failure', async () => {
    const f = setup(true); f.authority.issue.mockRejectedValue(new Error('secret SQL parameters'));
    await f.call();
    expect(f.http.jsonResponse.mock.calls[0][1]).toBe('503 Service Unavailable');
    expect(JSON.stringify(f.http.jsonResponse.mock.calls)).not.toContain('secret SQL');
    expect(f.authority.introspect).not.toHaveBeenCalled();
  });
  it('does not write to a response aborted during body collection', async () => {
    const f = setup(true);
    f.http.readBody.mockImplementationOnce(async (...args: unknown[]) => { (args[2] as () => void)(); return '{}'; });
    await f.call(); expect(f.http.jsonResponse).not.toHaveBeenCalled();
  });
});
