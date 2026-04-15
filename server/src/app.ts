/**
 * Cernere Server — uWebSockets.js アプリケーション
 *
 * WS メインの認証プラットフォーム。HTTP は OAuth コールバックと
 * 認証 REST の最小セットのみ。
 */

import uWS from "uWebSockets.js";
import { config } from "./config.js";
import { handleAuthRoute } from "./http/auth-handler.js";
import { handleCompositeRoute } from "./http/composite-handler.js";
import { handleOAuthRoute } from "./http/oauth-handler.js";
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
      const token = params.get("token") ?? undefined;
      const sessionId = params.get("session_id") ?? undefined;

      const secWsKey = req.getHeader("sec-websocket-key");
      const secWsProtocol = req.getHeader("sec-websocket-protocol");
      const secWsExtensions = req.getHeader("sec-websocket-extensions");

      let aborted = false;
      res.onAborted(() => { aborted = true; });

      const auth = await resolveWsAuth(token, sessionId);
      if (aborted) return;

      const userData: WsUserData = auth
        ? { userId: auth.userId, sessionId: auth.sessionId, isGuest: false, promoted: false, closed: false }
        : { userId: "", sessionId: `guest_${crypto.randomUUID()}`, isGuest: true, promoted: false, closed: false };

      res.cork(() => {
        res.upgrade(userData, secWsKey, secWsProtocol, secWsExtensions, context);
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
      const token = params.get("token") ?? undefined;
      const ip = getRemoteIp(res);

      const secWsKey = req.getHeader("sec-websocket-key");
      const secWsProtocol = req.getHeader("sec-websocket-protocol");
      const secWsExtensions = req.getHeader("sec-websocket-extensions");

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
        res.upgrade(userData, secWsKey, secWsProtocol, secWsExtensions, context);
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
      const ticket = params.get("ticket") ?? undefined;

      const secWsKey = req.getHeader("sec-websocket-key");
      const secWsProtocol = req.getHeader("sec-websocket-protocol");
      const secWsExtensions = req.getHeader("sec-websocket-extensions");

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
        res.upgrade(userData, secWsKey, secWsProtocol, secWsExtensions, context);
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

    try {
      const body = await readBody(res);
      if (aborted) return;
      const result = await handleAuthRoute(action, body, authHeader, { ip, userAgent });
      jsonResponse(res, result.status, result.data);
    } catch (err) {
      if (aborted) return;
      const msg = (err as Error).message;
      const status = msg.includes("Unauthorized") ? "401 Unauthorized"
        : msg.includes("not found") ? "404 Not Found" : "400 Bad Request";
      jsonResponse(res, status, { error: msg });
    }
  });

  // ── Composite Auth: POST /api/auth/composite/:action ────
  app.post("/api/auth/composite/:action", async (res, req) => {
    const action = req.getParameter(0) ?? "";
    const userAgent = req.getHeader("user-agent") ?? undefined;
    const ip = getRemoteIp(res);
    let aborted = false;
    res.onAborted(() => { aborted = true; });

    try {
      const body = await readBody(res);
      if (aborted) return;
      const result = await handleCompositeRoute(action, body, { ip, userAgent });
      jsonResponse(res, result.status, result.data);
    } catch (err) {
      if (aborted) return;
      const msg = (err as Error).message;
      const status = msg.includes("Unauthorized") ? "401 Unauthorized"
        : msg.includes("not found") ? "404 Not Found" : "400 Bad Request";
      jsonResponse(res, status, { error: msg });
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
