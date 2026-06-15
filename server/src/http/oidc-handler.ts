/**
 * OIDC Provider HTTP ハンドラ (uWebSockets.js)
 *
 * 外部 RP 向け (public, CORS *):
 *   GET  /.well-known/openid-configuration   discovery
 *   GET  /.well-known/jwks.json              署名公開鍵
 *   GET  /oidc/authorize                     認可 → consent へ redirect
 *   POST /oidc/token                         code → id_token + access_token
 *   GET  /oidc/userinfo                      access_token → claims
 *
 * フロント (consent 仲介、 CORS = frontendUrl + credentials):
 *   GET  /api/auth/oidc/request?request_id=  consent 表示用の情報
 *   POST /api/auth/oidc/approve              { request_id } + Bearer user token
 *   POST /api/auth/oidc/deny                 { request_id }
 */

import type uWS from "uWebSockets.js";
import { config } from "../config.js";
import { AppError } from "../error.js";
import { verifyToken, extractBearerToken } from "../auth/jwt.js";
import { isOidcEnabled, getOidcJwks } from "../auth/oidc-keys.js";
import { devLog, devError } from "../logging/dev-logger.js";
import {
  OidcError,
  createAuthorization,
  approveAuthorization,
  denyAuthorization,
  getConsentInfo,
  exchangeToken,
  userinfo,
  discoveryDocument,
  type TokenRequestParams,
} from "../oidc/provider.js";

// ── uWS ヘルパー ────────────────────────────────────────────

function readBody(res: uWS.HttpResponse): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    res.onData((chunk, isLast) => {
      buffer += Buffer.from(chunk).toString();
      if (isLast) resolve(buffer);
    });
    res.onAborted(() => reject(new Error("Request aborted")));
  });
}

function json(res: uWS.HttpResponse, status: string, data: unknown, origin = "*", credentials = false): void {
  res.cork(() => {
    res.writeStatus(status)
      .writeHeader("Content-Type", "application/json")
      .writeHeader("Access-Control-Allow-Origin", origin);
    if (credentials) res.writeHeader("Access-Control-Allow-Credentials", "true");
    res.writeHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(data));
  });
}

function redirect(res: uWS.HttpResponse, url: string): void {
  res.cork(() => {
    res.writeStatus("302 Found").writeHeader("Location", url).writeHeader("Cache-Control", "no-store").end();
  });
}

function htmlError(res: uWS.HttpResponse, status: string, message: string): void {
  res.cork(() => {
    res.writeStatus(status).writeHeader("Content-Type", "text/html; charset=utf-8").end(
      `<!doctype html><meta charset="utf-8"><title>Authorization error</title>` +
      `<body style="font-family:system-ui;padding:2rem"><h1>Authorization error</h1>` +
      `<p>${escapeHtml(message)}</p></body>`,
    );
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

function disabledGuard(res: uWS.HttpResponse): boolean {
  if (isOidcEnabled()) return false;
  json(res, "503 Service Unavailable", { error: "oidc_disabled", error_description: "OIDC provider is not configured" });
  return true;
}

// ── discovery / jwks ────────────────────────────────────────

export function handleOidcDiscovery(res: uWS.HttpResponse): void {
  if (disabledGuard(res)) return;
  res.cork(() => {
    res.writeStatus("200 OK")
      .writeHeader("Content-Type", "application/json")
      .writeHeader("Access-Control-Allow-Origin", "*")
      .writeHeader("Cache-Control", "public, max-age=300")
      .end(JSON.stringify(discoveryDocument()));
  });
}

export function handleOidcJwks(res: uWS.HttpResponse): void {
  if (disabledGuard(res)) return;
  res.cork(() => {
    res.writeStatus("200 OK")
      .writeHeader("Content-Type", "application/json")
      .writeHeader("Access-Control-Allow-Origin", "*")
      .writeHeader("Cache-Control", "public, max-age=300")
      .end(JSON.stringify(getOidcJwks()));
  });
}

// ── authorize ───────────────────────────────────────────────

export function handleOidcAuthorize(res: uWS.HttpResponse, req: uWS.HttpRequest): void {
  if (disabledGuard(res)) return;
  const query = req.getQuery() ?? "";
  let aborted = false;
  res.onAborted(() => { aborted = true; });

  (async () => {
    try {
      const outcome = await createAuthorization(new URLSearchParams(query));
      if (aborted) return;
      if (outcome.kind === "redirect") {
        redirect(res, outcome.url);
        return;
      }
      // consent 画面へ。 フロントが request_id を読んで承認/拒否する。
      redirect(res, `${config.frontendUrl}/oidc/consent?request_id=${encodeURIComponent(outcome.requestId)}`);
    } catch (err) {
      if (aborted) return;
      const msg = err instanceof Error ? err.message : "invalid request";
      devLog("oidc.authorize.error", { msg });
      htmlError(res, "400 Bad Request", msg);
    }
  })();
}

// ── token ───────────────────────────────────────────────────

/** form-encoded か JSON を判定してパースし、 Basic 認証も解決する。 */
function parseTokenBody(body: string, contentType: string, authHeader: string): TokenRequestParams {
  let fields: Record<string, string> = {};
  if (contentType.includes("application/json")) {
    try { fields = JSON.parse(body) as Record<string, string>; } catch { fields = {}; }
  } else {
    for (const [k, v] of new URLSearchParams(body)) fields[k] = v;
  }

  const params: TokenRequestParams = {
    grantType: fields.grant_type,
    code: fields.code,
    redirectUri: fields.redirect_uri,
    clientId: fields.client_id,
    clientSecret: fields.client_secret,
    codeVerifier: fields.code_verifier,
  };

  // client_secret_basic: Authorization: Basic base64(client_id:client_secret)
  if (authHeader.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
      const idx = decoded.indexOf(":");
      if (idx > 0) {
        params.clientId = decodeURIComponent(decoded.slice(0, idx));
        params.clientSecret = decodeURIComponent(decoded.slice(idx + 1));
      }
    } catch { /* ignore malformed basic auth */ }
  }

  return params;
}

export function handleOidcToken(res: uWS.HttpResponse, req: uWS.HttpRequest): void {
  if (disabledGuard(res)) return;
  const contentType = req.getHeader("content-type") ?? "";
  const authHeader = req.getHeader("authorization") ?? "";
  let aborted = false;
  res.onAborted(() => { aborted = true; });

  (async () => {
    try {
      const body = await readBody(res);
      if (aborted) return;
      const params = parseTokenBody(body, contentType, authHeader);
      const result = await exchangeToken(params);
      json(res, "200 OK", result);
    } catch (err) {
      if (aborted) return;
      if (err instanceof OidcError) {
        json(res, statusLine(err.httpStatus), { error: err.error, error_description: err.description });
      } else {
        devError("oidc.token.500", err);
        json(res, "500 Internal Server Error", { error: "server_error", error_description: "internal error" });
      }
    }
  })();
}

// ── userinfo ────────────────────────────────────────────────

export function handleOidcUserinfo(res: uWS.HttpResponse, req: uWS.HttpRequest): void {
  if (disabledGuard(res)) return;
  const authHeader = req.getHeader("authorization") ?? "";
  let aborted = false;
  res.onAborted(() => { aborted = true; });

  (async () => {
    try {
      const token = extractBearerToken(authHeader);
      const claims = await userinfo(token);
      json(res, "200 OK", claims);
    } catch (err) {
      if (aborted) return;
      // RFC 6750: 401 + WWW-Authenticate
      res.cork(() => {
        res.writeStatus("401 Unauthorized")
          .writeHeader("WWW-Authenticate", 'Bearer error="invalid_token"')
          .writeHeader("Content-Type", "application/json")
          .writeHeader("Access-Control-Allow-Origin", "*")
          .end(JSON.stringify({ error: "invalid_token", error_description: (err as Error).message }));
      });
    }
  })();
}

// ── consent (frontend) ──────────────────────────────────────

export function handleOidcConsentInfo(res: uWS.HttpResponse, req: uWS.HttpRequest): void {
  if (disabledGuard(res)) return;
  const query = new URLSearchParams(req.getQuery() ?? "");
  const requestId = query.get("request_id") ?? "";
  let aborted = false;
  res.onAborted(() => { aborted = true; });

  (async () => {
    try {
      const info = await getConsentInfo(requestId);
      if (aborted) return;
      if (!info) {
        json(res, "404 Not Found", { error: "Invalid or expired authorization request" }, config.frontendUrl, true);
        return;
      }
      json(res, "200 OK", info, config.frontendUrl, true);
    } catch (err) {
      if (aborted) return;
      json(res, "500 Internal Server Error", { error: (err as Error).message }, config.frontendUrl, true);
    }
  })();
}

export function handleOidcApprove(res: uWS.HttpResponse, req: uWS.HttpRequest): void {
  if (disabledGuard(res)) return;
  const authHeader = req.getHeader("authorization") ?? "";
  let aborted = false;
  res.onAborted(() => { aborted = true; });

  (async () => {
    try {
      const token = extractBearerToken(authHeader);
      if (!token) throw AppError.unauthorized("No token provided");
      const claims = verifyToken(token);

      const body = await readBody(res);
      if (aborted) return;
      const requestId = (parseJson(body).request_id as string | undefined) ?? "";
      if (!requestId) throw AppError.badRequest("request_id is required");

      const result = await approveAuthorization(requestId, claims.sub);
      json(res, "200 OK", result, config.frontendUrl, true);
    } catch (err) {
      if (aborted) return;
      const status = err instanceof AppError ? statusLine(err.statusCode) : "400 Bad Request";
      json(res, status, { error: (err as Error).message }, config.frontendUrl, true);
    }
  })();
}

export function handleOidcDeny(res: uWS.HttpResponse, req: uWS.HttpRequest): void {
  if (disabledGuard(res)) return;
  let aborted = false;
  res.onAborted(() => { aborted = true; });

  (async () => {
    try {
      const body = await readBody(res);
      if (aborted) return;
      const requestId = (parseJson(body).request_id as string | undefined) ?? "";
      if (!requestId) throw AppError.badRequest("request_id is required");
      const result = await denyAuthorization(requestId);
      json(res, "200 OK", result, config.frontendUrl, true);
    } catch (err) {
      if (aborted) return;
      const status = err instanceof AppError ? statusLine(err.statusCode) : "400 Bad Request";
      json(res, status, { error: (err as Error).message }, config.frontendUrl, true);
    }
  })();
}

// ── misc ────────────────────────────────────────────────────

function parseJson(body: string): Record<string, unknown> {
  if (!body) return {};
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return {}; }
}

function statusLine(code: number): string {
  const map: Record<number, string> = {
    400: "400 Bad Request",
    401: "401 Unauthorized",
    403: "403 Forbidden",
    404: "404 Not Found",
    500: "500 Internal Server Error",
  };
  return map[code] ?? `${code} Error`;
}
