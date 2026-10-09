import type uWS from 'uWebSockets.js';
import { AppError } from '../error.js';
import { checkRateLimit } from '../redis.js';
import { WorkloadAuthority } from '../workload/authority.js';
import { workloadStore } from '../workload/store.js';

export interface WorkloadHttpHelpers {
  readBody(res: uWS.HttpResponse, maxBytes: number, onAborted: () => void): Promise<string>;
  jsonResponse(res: uWS.HttpResponse, status: string, data: unknown, cookies: string[], headers: Readonly<Record<string, string>>): void;
  getRemoteIp(res: uWS.HttpResponse): string | undefined;
  classifyError(error: unknown): { status: string; message: string };
}
interface Authority {
  issue(input: unknown): Promise<unknown>;
  introspect(input: unknown): Promise<unknown>;
}

export function registerWorkloadRoutes(
  app: uWS.TemplatedApp, http: WorkloadHttpHelpers, tls: boolean,
  authority: Authority = new WorkloadAuthority({ store: workloadStore }),
  limit: typeof checkRateLimit = checkRateLimit,
): void {
  const noStore = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };
  for (const action of ['token', 'introspect'] as const) {
    app.post(`/api/workload/${action}`, async (res, req) => {
      // tls derives exclusively from SSLApp creation; forwarded headers are not evidence.
      if (!tls) {
        http.jsonResponse(res, '403 Forbidden', { error: 'Workload endpoints require TLS' }, [], noStore);
        return;
      }
      const contentType = req.getHeader('content-type').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        http.jsonResponse(res, '400 Bad Request', { error: 'JSON is required' }, [], noStore);
        return;
      }
      const ip = http.getRemoteIp(res) ?? 'unknown';
      let aborted = false;
      try {
        const raw = await http.readBody(res, 16384, () => { aborted = true; });
        if (aborted) return;
        await limit(`workload:${action}:${ip}`, 120, 60);
        let input: unknown;
        try { input = JSON.parse(raw); } catch { throw AppError.badRequest('Invalid workload request'); }
        const result = action === 'token' ? await authority.issue(input) : await authority.introspect(input);
        if (!aborted) http.jsonResponse(res, '200 OK', result, [], noStore);
      } catch (error) {
        if (aborted) return;
        const failure = error instanceof AppError ? http.classifyError(error)
          : { status: '503 Service Unavailable', message: 'Workload authority unavailable' };
        // Never log raw DB/crypto errors: they can contain credentials or query parameters.
        http.jsonResponse(res, failure.status, { error: failure.message }, [], noStore);
      }
    });
  }
}
