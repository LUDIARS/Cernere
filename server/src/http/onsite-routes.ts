/**
 * 現地確認 MFA の HTTP transport (kiosk 管理者 API と Ostiarius からの attestation 受け口)。
 * 利用者端末の onsite/start は既存の /api/auth/mfa/* (mfa-routes.ts) に載せている。
 * @implements SPEC-MFA-ONSITE
 */
import type uWS from "uWebSockets.js";
import { AppError } from "../error.js";
import { limitMfa } from "../auth/mfa-records.js";
import { handleOnsiteKioskAdmin } from "./onsite-kiosk-admin-handler.js";
import { handleOnsiteAttestation } from "./onsite-attestation-handler.js";

interface HttpHelpers {
  readBody(res: uWS.HttpResponse, maxBytes: number, onAborted: () => void): Promise<string>;
  jsonResponse(res: uWS.HttpResponse, status: string, data: unknown, cookies: string[], headers: Readonly<Record<string, string>>): void;
  getRemoteIp(res: uWS.HttpResponse): string | undefined;
  classifyError(error: unknown): { status: string; message: string };
}

type Handler = (authHeader: string, body: unknown, parameter: string) => Promise<unknown>;

const NO_STORE = { "Cache-Control": "no-store" } as const;

function decodeParameter(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw AppError.badRequest("Invalid path parameter"); }
}

export function registerOnsiteRoutes(app: uWS.TemplatedApp, http: HttpHelpers): void {
  const endpoint = (handler: Handler, post: boolean, maxBytes: number) => async (res: uWS.HttpResponse, req: uWS.HttpRequest) => {
    const auth = req.getHeader("authorization") ?? "";
    const parameter = req.getParameter(0) ?? "";
    const ip = http.getRemoteIp(res);
    let aborted = false;
    // readBody registers its own onAborted; uWS rejects a second registration on the same response.
    if (!post) res.onAborted(() => { aborted = true; });
    try {
      let body: unknown = {};
      if (post) {
        const raw = await http.readBody(res, maxBytes, () => { aborted = true; });
        if (aborted) return;
        try { body = JSON.parse(raw || "{}"); } catch { throw AppError.badRequest("Invalid JSON"); }
      }
      await limitMfa(`onsite-http:${ip ?? "unknown"}`, 120, 60);
      const data = await handler(auth, body, parameter);
      if (!aborted) http.jsonResponse(res, "200 OK", data, [], NO_STORE);
    } catch (error) {
      if (aborted) return;
      // Internal DB/crypto failures must not expose keys, SQL parameters or ticket state.
      const failure = error instanceof AppError ? http.classifyError(error)
        : { status: "503 Service Unavailable", message: "Onsite verification is temporarily unavailable" };
      http.jsonResponse(res, failure.status, { error: failure.message }, [], NO_STORE);
    }
  };

  app.get("/api/admin/onsite-kiosks", endpoint((auth) => handleOnsiteKioskAdmin("list", auth, {}), false, 0));
  app.post("/api/admin/onsite-kiosks", endpoint((auth, body) => handleOnsiteKioskAdmin("register", auth, body), true, 8192));
  app.post("/api/admin/onsite-kiosks/:lanId/revoke",
    endpoint((auth, _body, lanId) => handleOnsiteKioskAdmin("revoke", auth, {}, decodeParameter(lanId)), true, 1024));
  app.post("/api/mfa/onsite/attestations", endpoint((auth, body) => handleOnsiteAttestation(auth, body), true, 8192));
}
