/**
 * Cernere Server — uWebSockets.js アプリケーション
 *
 * WS メインの認証プラットフォーム。HTTP は OAuth コールバックと
 * 認証 REST の最小セットのみ。
 */

import uWS from "uWebSockets.js";
import { config } from "./config.js";
import { handleAuthRoute } from "./http/auth-handler.js";
import { handlePasskeyRoute } from "./http/passkey-handler.js";
import { exportProjectSchemas } from "./http/project-schema-handler.js";
import { getPublicKeys } from "./auth/paseto.js";
import { handleCompositeRoute } from "./http/composite-handler.js";
import { handleOAuthRoute } from "./http/oauth-handler.js";
import {
  handleOidcDiscovery,
  handleOidcJwks,
  handleOidcAuthorize,
  handleOidcToken,
  handleOidcUserinfo,
  handleOidcConsentInfo,
  handleOidcApprove,
  handleOidcDeny,
} from "./http/oidc-handler.js";
import { devLog, devError } from "./logging/dev-logger.js";
import { AppError } from "./error.js";
import {
  handleWsOpen,
  handleWsMessage,
  handleWsClose,
} from "./ws/handler.js";
import { resolveWsAuth } from "./ws/auth.js";
import {
  handleProjectWsOpen,
  handleProjectWsMessage,
  handleProjectWsClose,
  resolveProjectWsAuth,
  type ProjectWsUserData,
} from "./ws/project-handler.js";
import {
  handleCompositeAuthOpen,
  handleCompositeAuthMessage,
  handleCompositeAuthClose,
  resolveCompositeTicket,
  type CompositeWsUserData,
} from "./ws/composite-auth.js";
import { logProjectWsRejected } from "./logging/auth-logger.js";

// ── uWS UserData (WS 接続ごとに保持) ──────────────────────

export interface WsUserData {
  userId: string;
  sessionId: string;
  isGuest: boolean;
  promoted: boolean;
  /** upgrade 時の接続元 IP (ゲストログインの per-IP レート制限に使う。監査用途)。 */
  ip?: string;
  /**
   * close 後に send() するレースを防ぐフラグ。close ハンドラで即 true にする。
   * uWS は閉じた WebSocket を触ると例外を投げるため、async の await 挟み後の
   * send は必ず closed チェックが必要。
   */
  closed: boolean;
}

// ── HTTP ヘルパー ──────────────────────────────────────────

function getRemoteIp(res: uWS.HttpResponse): string | undefined {
  try {
    const text = Buffer.from(res.getRemoteAddressAsText()).toString();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/**
 * WS 認証情報を Sec-WebSocket-Protocol 経由で受け取る。
 *
 * URL クエリ (`?token=...`) は reverse proxy / アクセスログ / ブラウザ履歴に
 * 平文で残るため、 credential は subprotocol に載せるのが安全。 クライアントは
 *   Sec-WebSocket-Protocol: bearer, <jwt>
 *   Sec-WebSocket-Protocol: session, <session_id>
 *   Sec-WebSocket-Protocol: ticket, <ticket>
 * のように「スキーム, 値」のペアを並べる。 サーバは認識したスキーム名 (値では
 * ない) だけを echo して upgrade する (echo は必ずクライアント提示リスト内の
 * 単一 subprotocol でなければならない)。
 *
 * 後方互換: 当面は URL クエリも fallback として受理する (呼び出し側で query を
 * OR する)。 全クライアント (frontend + 各 service) 移行後に query 受理を撤去する。
 */
function parseWsAuthProtocol(
  protoHeader: string | undefined,
): { creds: Map<string, string>; echo?: string } {
  const creds = new Map<string, string>();
  let echo: string | undefined;
  if (!protoHeader) return { creds };
  const parts = protoHeader.split(",").map((s) => s.trim()).filter(Boolean);
  const known = new Set(["bearer", "session", "ticket"]);
  for (let i = 0; i < parts.length - 1; i++) {
    const scheme = parts[i];
    const value = parts[i + 1];
    if (known.has(scheme) && value && !creds.has(scheme)) {
      creds.set(scheme, value);
      if (!echo) echo = scheme; // 最初に認識したスキーム名を echo する
    }
  }
  return { creds, echo };
}

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

function jsonResponse(res: uWS.HttpResponse, status: string, data: unknown): void {
  res.cork(() => {
    res.writeStatus(status)
      .writeHeader("Content-Type", "application/json")
      .writeHeader("Access-Control-Allow-Origin", config.frontendUrl)
      .writeHeader("Access-Control-Allow-Credentials", "true")
      .end(JSON.stringify(data));
  });
}

/**
 * 認証ハンドラの throw を HTTP ステータスにマップする。
 * 既知の業務エラー (Unauthorized / not found / Rate limit / required) は
 * 4xx に、それ以外は 500 として扱う (サーバー側の不具合をクライアントに
 * 200/400 で隠蔽しないため)。
 */
const STATUS_TEXT: Record<number, string> = {
  400: "400 Bad Request",
  401: "401 Unauthorized",
  403: "403 Forbidden",
  404: "404 Not Found",
  409: "409 Conflict",
  429: "429 Too Many Requests",
  500: "500 Internal Server Error",
};

function classifyError(err: unknown): { status: string; message: string } {
  // AppError は statusCode を明示的に持つため、メッセージ文言の正規表現マッチに
  // 依存せずそのまま使う。 メッセージがどんな文言でも (例: "Invalid or expired
  // token" のように "Unauthorized" を含まない) 正しい 4xx にマップされる。
  if (err instanceof AppError) {
    const status = STATUS_TEXT[err.statusCode] ?? "500 Internal Server Error";
    const message = err.statusCode >= 500 && !config.isDevelopment ? "Internal server error" : err.message;
    return { status, message };
  }

  const msg = err instanceof Error ? err.message : String(err ?? "Internal error");

  if (/Unauthorized/i.test(msg)) return { status: "401 Unauthorized", message: msg };
  if (/Forbidden/i.test(msg)) return { status: "403 Forbidden", message: msg };
  if (/not found/i.test(msg)) return { status: "404 Not Found", message: msg };
  if (/Rate limit/i.test(msg)) return { status: "429 Too Many Requests", message: msg };

  // 入力検証で投げる典型的な業務エラー
  if (
    /required/i.test(msg)
    || /must be at least/i.test(msg)
    || /Registration failed/i.test(msg)
    || /Invalid (or expired )?(refresh token|MFA token|auth code)/i.test(msg)
    || /code is required/i.test(msg)
  ) {
    return { status: "400 Bad Request", message: msg };
  }

  // 上記に当てはまらない throw は予期せぬ内部エラー扱い
  return {
    status: "500 Internal Server Error",
    message: config.isDevelopment ? msg : "Internal server error",
  };
}

// ── App 生成 ──────────────────────────────────────────────

export function createApp() {
  const app = uWS.App();

  // ── CORS preflight ──────────────────────────────────────
  app.options("/*", (res) => {
    res.cork(() => {
      res.writeStatus("204 No Content")
        .writeHeader("Access-Control-Allow-Origin", config.frontendUrl)
        .writeHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        .writeHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
        .writeHeader("Access-Control-Allow-Credentials", "true")
        .end();
    });
  });

  // ── WebSocket: /auth ────────────────────────────────────
  app.ws<WsUserData>("/auth", {
    maxPayloadLength: 16 * 1024 * 1024,
    idleTimeout: 120,

    upgrade: async (res, req, context) => {
      const query = req.getQuery();
      const params = new URLSearchParams(query);
      const ip = getRemoteIp(res);

      const secWsKey = req.getHeader("sec-websocket-key");
      const secWsProtocol = req.getHeader("sec-websocket-protocol");
      const secWsExtensions = req.getHeader("sec-websocket-extensions");

      // header 優先、 URL クエリは deprecated fallback。
      const { creds, echo } = parseWsAuthProtocol(secWsProtocol);
      const token = creds.get("bearer") ?? params.get("token") ?? undefined;
      const sessionId = creds.get("session") ?? params.get("session_id") ?? undefined;
      if (!creds.size && (params.get("token") || params.get("session_id"))) {
        devLog("ws.auth.credentialInQuery.deprecated", { path: "/auth", ip });
      }
      // header 認証時は echo したスキーム名のみ返す (値を含む生ヘッダは返さない)。
      const echoProtocol = echo ?? secWsProtocol;

      let aborted = false;
      res.onAborted(() => { aborted = true; });

      const auth = await resolveWsAuth(token, sessionId);
      if (aborted) return;

      const userData: WsUserData = auth
        ? { userId: auth.userId, sessionId: auth.sessionId, isGuest: false, promoted: false, closed: false, ip }
        : { userId: "", sessionId: `guest_${crypto.randomUUID()}`, isGuest: true, promoted: false, closed: false, ip };

      res.cork(() => {
        res.upgrade(userData, secWsKey, echoProtocol, secWsExtensions, context);
      });
    },

    open: (ws) => { handleWsOpen(ws); },
    message: (ws, message) => { handleWsMessage(ws, message); },
    close: (ws) => { handleWsClose(ws); },
  });

  // ── WebSocket: /ws/project (プロジェクト認証経由) ───────
  app.ws<ProjectWsUserData>("/ws/project", {
    maxPayloadLength: 16 * 1024 * 1024,
    idleTimeout: 120,

    upgrade: async (res, req, context) => {
      const query = req.getQuery();
      const params = new URLSearchParams(query);
      const ip = getRemoteIp(res);

      const secWsKey = req.getHeader("sec-websocket-key");
      const secWsProtocol = req.getHeader("sec-websocket-protocol");
      const secWsExtensions = req.getHeader("sec-websocket-extensions");

      const { creds, echo } = parseWsAuthProtocol(secWsProtocol);
      const token = creds.get("bearer") ?? params.get("token") ?? undefined;
      if (!creds.size && params.get("token")) {
        devLog("ws.auth.credentialInQuery.deprecated", { path: "/ws/project", ip });
      }
      const echoProtocol = echo ?? secWsProtocol;

      let aborted = false;
      res.onAborted(() => { aborted = true; });

      const claims = await resolveProjectWsAuth(token);
      if (aborted) return;

      if (!claims) {
        logProjectWsRejected(token ? "invalid or expired project token" : "missing project token", { ip });
        res.cork(() => {
          res.writeStatus("401 Unauthorized").end("Invalid project token");
        });
        return;
      }

      const userData: ProjectWsUserData = {
        clientId: claims.sub,
        projectKey: claims.projectKey,
        connectionId: `proj_${crypto.randomUUID()}`,
        closed: false,
      };

      res.cork(() => {
        res.upgrade(userData, secWsKey, echoProtocol, secWsExtensions, context);
      });
    },

    open: (ws) => { handleProjectWsOpen(ws); },
    message: (ws, message) => { handleProjectWsMessage(ws, message); },
    close: (ws) => { handleProjectWsClose(ws); },
  });

  // ── WebSocket: /auth/composite-ws (ticket 認証) ─────────
  // 資格情報検証済みセッションのチケットでアップグレード。
  // デバイス fingerprint / 本人確認コードのやり取りを担う。
  app.ws<CompositeWsUserData>("/auth/composite-ws", {
    maxPayloadLength: 1 * 1024 * 1024,
    idleTimeout: 60,

    upgrade: async (res, req, context) => {
      const query = req.getQuery();
      const params = new URLSearchParams(query);
      const ip = getRemoteIp(res);

      const secWsKey = req.getHeader("sec-websocket-key");
      const secWsProtocol = req.getHeader("sec-websocket-protocol");
      const secWsExtensions = req.getHeader("sec-websocket-extensions");

      const { creds, echo } = parseWsAuthProtocol(secWsProtocol);
      const ticket = creds.get("ticket") ?? params.get("ticket") ?? undefined;
      if (!creds.size && params.get("ticket")) {
        devLog("ws.auth.credentialInQuery.deprecated", { path: "/auth/composite-ws", ip });
      }
      const echoProtocol = echo ?? secWsProtocol;

      let aborted = false;
      res.onAborted(() => { aborted = true; });

      const session = await resolveCompositeTicket(ticket);
      if (aborted) return;

      if (!session) {
        res.cork(() => {
          res.writeStatus("401 Unauthorized").end("Invalid or expired ticket");
        });
        return;
      }

      const userData: CompositeWsUserData = {
        ticket: session.ticket,
        userId: session.user.userId,
        closed: false,
      };

      res.cork(() => {
        res.upgrade(userData, secWsKey, echoProtocol, secWsExtensions, context);
      });
    },

    open: (ws) => { void handleCompositeAuthOpen(ws); },
    message: (ws, message) => { void handleCompositeAuthMessage(ws, message); },
    close: (ws) => { handleCompositeAuthClose(ws); },
  });

  // ── Auth REST: POST /api/auth/:action ───────────────────
  app.post("/api/auth/:action", async (res, req) => {
    const action = req.getParameter(0) ?? "";
    const authHeader = req.getHeader("authorization") ?? "";
    const userAgent = req.getHeader("user-agent") ?? undefined;
    const ip = getRemoteIp(res);
    let aborted = false;
    res.onAborted(() => { aborted = true; });

    devLog("http.auth.begin", { action, ip, userAgent });
    try {
      const body = await readBody(res);
      if (aborted) return;
      devLog("http.auth.body", { action, bodyLen: body.length });
      const result = await handleAuthRoute(action, body, authHeader, { ip, userAgent });
      devLog("http.auth.ok", { action, status: result.status });
      jsonResponse(res, result.status, result.data);
    } catch (err) {
      if (aborted) return;
      const { status, message } = classifyError(err);
      if (status === "500 Internal Server Error") {
        devError("http.auth.500", err, { action, ip });
        console.error(`[http] auth/${action} 500:`, err);
      } else {
        devLog("http.auth.error", { action, status, message });
      }
      jsonResponse(res, status, { error: message });
    }
  });

  // ── Passkey (WebAuthn): POST /api/auth/passkey/:action ──
  app.post("/api/auth/passkey/:action", async (res, req) => {
    const action = req.getParameter(0) ?? "";
    const authHeader = req.getHeader("authorization") ?? "";
    const userAgent = req.getHeader("user-agent") ?? undefined;
    const ip = getRemoteIp(res);
    let aborted = false;
    res.onAborted(() => { aborted = true; });

    devLog("http.passkey.begin", { action, ip, userAgent });
    try {
      const body = await readBody(res);
      if (aborted) return;
      const result = await handlePasskeyRoute(action, body, authHeader, { ip, userAgent });
      devLog("http.passkey.ok", { action, status: result.status });
      jsonResponse(res, result.status, result.data);
    } catch (err) {
      if (aborted) return;
      const { status, message } = classifyError(err);
      if (status === "500 Internal Server Error") {
        devError("http.passkey.500", err, { action, ip });
        console.error(`[http] passkey/${action} 500:`, err);
      } else {
        devLog("http.passkey.error", { action, status, message });
      }
      jsonResponse(res, status, { error: message });
    }
  });

  // ── Passkey export (GET): bulk 公開鍵取得 (admin/service 限定) ──
  // Ostiarius 等の会場ゲートウェイがオフライン検証用に登録済み passkey の
  // 公開鍵を取得する。 GET なので body は無く、 ?project=<key> を query で受ける。
  // CONTRACTS.md §2 / handlePasskeyRoute("export")。
  app.get("/api/auth/passkey/export", async (res, req) => {
    const authHeader = req.getHeader("authorization") ?? "";
    const query = req.getQuery() ?? "";
    const ip = getRemoteIp(res);
    let aborted = false;
    res.onAborted(() => { aborted = true; });

    devLog("http.passkey.export.begin", { ip });
    try {
      const result = await handlePasskeyRoute("export", "", authHeader, { ip }, query);
      if (aborted) return;
      devLog("http.passkey.export.ok", { status: result.status });
      jsonResponse(res, result.status, result.data);
    } catch (err) {
      if (aborted) return;
      const { status, message } = classifyError(err);
      if (status === "500 Internal Server Error") {
        devError("http.passkey.export.500", err, { ip });
        console.error("[http] passkey/export 500:", err);
      } else {
        devLog("http.passkey.export.error", { status, message });
      }
      jsonResponse(res, status, { error: message });
    }
  });

  // ── Project schema export (GET): スキーマ定義 shape のみ (admin/service 限定) ──
  // Foedus (クロスサービス契約/PII レビューア) がコミット済み JSON の代わりに
  // レビュー時にライブでスキーマ shape (カラム名/型/module) を取得するための
  // エンドポイント。 PII フィールド構造を恒久的な git 記録として残さないための
  // 変更。 project_data_<key> の実データ行は返さない (project-schema-handler.ts /
  // exportProjectSchemaDefinitions を参照)。 ?key=<projectKey> で単一プロジェクトに
  // 絞り込み可能 (省略時は active 全件)。
  app.get("/api/admin/projects/schema-export", async (res, req) => {
    const authHeader = req.getHeader("authorization") ?? "";
    const query = req.getQuery() ?? "";
    const ip = getRemoteIp(res);
    let aborted = false;
    res.onAborted(() => { aborted = true; });

    devLog("http.project.schema-export.begin", { ip });
    try {
      const result = await exportProjectSchemas(authHeader, query);
      if (aborted) return;
      devLog("http.project.schema-export.ok", { status: result.status });
      jsonResponse(res, result.status, result.data);
    } catch (err) {
      if (aborted) return;
      const { status, message } = classifyError(err);
      if (status === "500 Internal Server Error") {
        devError("http.project.schema-export.500", err, { ip });
        console.error("[http] admin/projects/schema-export 500:", err);
      } else {
        devLog("http.project.schema-export.error", { status, message });
      }
      jsonResponse(res, status, { error: message });
    }
  });

  // ── Composite Auth: POST /api/auth/composite/:action ────
  app.post("/api/auth/composite/:action", async (res, req) => {
    const action = req.getParameter(0) ?? "";
    const userAgent = req.getHeader("user-agent") ?? undefined;
    const ip = getRemoteIp(res);
    let aborted = false;
    res.onAborted(() => { aborted = true; });

    devLog("http.composite.begin", { action, ip, userAgent });
    try {
      const body = await readBody(res);
      if (aborted) return;
      devLog("http.composite.body", { action, bodyLen: body.length });
      const result = await handleCompositeRoute(action, body, { ip, userAgent });
      devLog("http.composite.ok", { action, status: result.status });
      jsonResponse(res, result.status, result.data);
    } catch (err) {
      if (aborted) return;
      const { status, message } = classifyError(err);
      if (status === "500 Internal Server Error") {
        devError("http.composite.500", err, { action, ip });
        console.error(`[http] composite/${action} 500:`, err);
      } else {
        devLog("http.composite.error", { action, status, message });
      }
      jsonResponse(res, status, { error: message });
    }
  });

  // ── Auth REST: GET /api/auth/me ─────────────────────────
  app.get("/api/auth/me", async (res, req) => {
    const authHeader = req.getHeader("authorization") ?? "";
    let aborted = false;
    res.onAborted(() => { aborted = true; });

    try {
      const result = await handleAuthRoute("me", "", authHeader);
      if (aborted) return;
      jsonResponse(res, result.status, result.data);
    } catch (err) {
      if (aborted) return;
      jsonResponse(res, "401 Unauthorized", { error: (err as Error).message });
    }
  });

  // ── OAuth callbacks ─────────────────────────────────────
  app.get("/auth/github/login", (res, req) => handleOAuthRoute(res, req, "github", "login"));
  app.get("/auth/github/callback", (res, req) => handleOAuthRoute(res, req, "github", "callback"));
  app.get("/auth/google/login", (res, req) => handleOAuthRoute(res, req, "google", "login"));
  app.get("/auth/google/callback", (res, req) => handleOAuthRoute(res, req, "google", "callback"));

  // ── PASETO 公開鍵 (well-known) ────────────────────────────
  // service (= Memoria Hub 等) が起動時 + 定期 fetch して project-token を
  // local verify するための public key。 認証不要・キャッシュ可。
  // Issue #91 / Phase 1 を参照。
  app.get("/.well-known/cernere-public-key", (res) => {
    const keys = getPublicKeys();
    res.cork(() => {
      res.writeHeader("cache-control", "public, max-age=600");
      jsonResponse(res, "200 OK", { keys });
    });
  });

  // ── OIDC Provider (OpenID Connect IdP) ───────────────────
  // Cernere を IdP とする RP (Cloudflare Access 等) 向け。 spec/feature/oidc-provider.md。
  app.get("/.well-known/openid-configuration", (res) => handleOidcDiscovery(res));
  app.get("/.well-known/jwks.json", (res) => handleOidcJwks(res));
  app.get("/oidc/authorize", (res, req) => handleOidcAuthorize(res, req));
  app.post("/oidc/token", (res, req) => handleOidcToken(res, req));
  app.get("/oidc/userinfo", (res, req) => handleOidcUserinfo(res, req));
  // consent はフロント (/oidc/consent) が仲介する。
  app.get("/api/auth/oidc/request", (res, req) => handleOidcConsentInfo(res, req));
  app.post("/api/auth/oidc/approve", (res, req) => handleOidcApprove(res, req));
  app.post("/api/auth/oidc/deny", (res, req) => handleOidcDeny(res, req));

  // ── Health check ────────────────────────────────────────
  app.get("/health", (res) => {
    jsonResponse(res, "200 OK", { status: "ok", timestamp: new Date().toISOString() });
  });

  // ── 404 ─────────────────────────────────────────────────
  app.any("/*", (res) => {
    jsonResponse(res, "404 Not Found", { error: "Not found" });
  });

  return app;
}
