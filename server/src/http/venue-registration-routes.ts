/**
 * 会場ネットワーク限定の新規登録の HTTP transport (spec/feature/venue-network-registration.md §6)。
 * 応答は no-store。内部障害 (DB 等) は詳細を出さずに 503 にする (onsite-routes.ts と同じ方針)。
 * @implements SPEC-VENUE-REGISTRATION
 */
import type uWS from "uWebSockets.js";
import { AppError } from "../error.js";
import { checkRateLimit } from "../redis.js";
import { rateLimitSubject } from "./rate-limit-subject.js";
import { handleVenueRegistration, type VenueRegistrationAction } from "./venue-registration-handler.js";

interface HttpHelpers {
  readBody(res: uWS.HttpResponse, maxBytes: number, onAborted: () => void): Promise<string>;
  jsonResponse(res: uWS.HttpResponse, status: string, data: unknown, cookies: string[], headers: Readonly<Record<string, string>>): void;
  getRemoteIp(res: uWS.HttpResponse, req: uWS.HttpRequest): string | undefined;
  classifyError(error: unknown): { status: string; message: string };
}

const NO_STORE = { "Cache-Control": "no-store" } as const;
/** 登録画面は約 2 秒ごとに状態を見る。5 分の challenge 1 つで 150 回なので、接続元あたりはその数倍まで。 */
const PER_SOURCE_PER_MINUTE = 120;

export function registerVenueRegistrationRoutes(app: uWS.TemplatedApp, http: HttpHelpers): void {
  const endpoint = (action: VenueRegistrationAction, post: boolean) => async (res: uWS.HttpResponse, req: uWS.HttpRequest) => {
    const authHeader = req.getHeader("authorization") ?? "";
    const query = new URLSearchParams(req.getQuery() ?? "");
    const ip = http.getRemoteIp(res, req);
    let aborted = false;
    // readBody registers its own onAborted; uWS rejects a second registration on the same response.
    if (!post) res.onAborted(() => { aborted = true; });
    try {
      let body: unknown = {};
      if (post) {
        const raw = await http.readBody(res, 8192, () => { aborted = true; });
        if (aborted) return;
        try { body = JSON.parse(raw || "{}"); } catch { throw AppError.badRequest("Invalid JSON"); }
      }
      await checkRateLimit(`venue-registration-http:${rateLimitSubject(ip)}`, PER_SOURCE_PER_MINUTE, 60);
      const data = await handleVenueRegistration(action, { authHeader, body, query, ip });
      if (!aborted) http.jsonResponse(res, "200 OK", data, [], NO_STORE);
    } catch (error) {
      if (aborted) return;
      const failure = error instanceof AppError || (error instanceof Error && /Rate limit/i.test(error.message))
        ? http.classifyError(error)
        : { status: "503 Service Unavailable", message: "Venue check is temporarily unavailable" };
      http.jsonResponse(res, failure.status, { error: failure.message }, [], NO_STORE);
    }
  };

  app.post("/api/auth/venue-registration/start", endpoint("start", true));
  app.post("/api/auth/venue-registration/attestations", endpoint("attestations", true));
  app.get("/api/auth/venue-registration/status", endpoint("status", false));
}
