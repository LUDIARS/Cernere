/** Bounded, no-store HTTP transport for MFA. @implements SPEC-MFA-SETTINGS */
import type uWS from "uWebSockets.js";
import { AppError } from "../error.js";
import { limitMfa } from "../auth/mfa-records.js";
import { handleMfaRoute } from "./mfa-handler.js";

interface HttpHelpers {
  readBody(res: uWS.HttpResponse, maxBytes: number, onAborted: () => void): Promise<string>;
  jsonResponse(res: uWS.HttpResponse, status: string, data: unknown, cookies: string[], headers: Readonly<Record<string, string>>): void;
  getRemoteIp(res: uWS.HttpResponse): string | undefined;
  classifyError(error: unknown): { status: string; message: string };
}

export function registerMfaRoutes(app: uWS.TemplatedApp, http: HttpHelpers): void {
  const endpoint = (action: string, post: boolean) => async (res: uWS.HttpResponse, req: uWS.HttpRequest) => {
    const auth = req.getHeader("authorization") ?? "";
    const proof = req.getHeader("x-cernere-action-proof") ?? "";
    const ip = http.getRemoteIp(res);
    let aborted = false;
    // readBody registers its own onAborted; uWS rejects a second registration on the same response.
    if (!post) res.onAborted(() => { aborted = true; });
    try {
      let body: unknown = {};
      // Register body callbacks before awaiting any I/O; uWS request lifetime ends on return.
      if (post) {
        const raw = await http.readBody(res, 4096, () => { aborted = true; });
        if (aborted) return;
        try { body = JSON.parse(raw || "{}"); } catch { throw AppError.badRequest("Invalid JSON"); }
      }
      await limitMfa(`http:${ip ?? "unknown"}`, 60, 60);
      if (aborted) return;
      const data = await handleMfaRoute(action, body, auth, proof);
      if (!aborted) http.jsonResponse(res, "200 OK", data, [], { "Cache-Control": "no-store" });
    } catch (error) {
      if (aborted) return;
      // Internal DB/crypto/delivery errors must not expose secrets, SQL parameters or providers.
      const failure = error instanceof AppError ? http.classifyError(error)
        : { status: "503 Service Unavailable", message: "MFA is temporarily unavailable" };
      http.jsonResponse(res, failure.status, { error: failure.message }, [], { "Cache-Control": "no-store" });
    }
  };
  app.get("/api/auth/mfa/status", endpoint("status", false));
  for (const action of ["send-code", "verify", "manage/begin", "manage/verify", "manage/send-code",
    "totp/setup", "totp/enable", "totp/disable", "email/setup", "email/enable", "email/disable"]) {
    app.post(`/api/auth/mfa/${action}`, endpoint(action, true));
  }
}
