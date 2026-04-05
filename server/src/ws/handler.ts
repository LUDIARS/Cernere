/**
 * WebSocket セッションハンドラ
 *
 * - 認証済み: JWT/session_id で接続 → 全コマンド利用可能
 * - ゲスト: 認証情報なしで接続 → auth コマンドのみ → 認証後に昇格
 */

import type { WSContext, WSEvents } from "hono/ws";
import { verifyToken } from "../auth/jwt.js";
import { config } from "../config.js";
import {
  putSession, getSession, setUserState, updateUserStateField, updateLastPing,
  SESSION_TTL_SECS, type UserFullState,
} from "../redis.js";
import { sessionRegistry } from "./session-registry.js";
import { dispatch } from "../commands.js";
import { handleGuestAuthCommand } from "./guest.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";

const PING_INTERVAL_MS = 30_000;

function send(ws: WSContext, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

// ── 認証済みセッション ──────────────────────────────────────

export function createAuthenticatedWsHandler(userId: string, sessionId: string): WSEvents {
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  return {
    async onOpen(_evt, ws) {
      sessionRegistry.register(sessionId, userId, ws);

      const now = Date.now();
      const userState: UserFullState = {
        userId,
        sessionId,
        state: "logged_in",
        modules: [],
        lastPingAt: Math.floor(now / 1000),
      };
      await setUserState(userState);

      send(ws, { type: "connected", session_id: sessionId, user_state: userState });

      pingTimer = setInterval(() => {
        send(ws, { type: "ping", ts: Math.floor(Date.now() / 1000) });
      }, PING_INTERVAL_MS);
    },

    async onMessage(evt, ws) {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(typeof evt.data === "string" ? evt.data : evt.data.toString());
      } catch {
        send(ws, { type: "error", code: "invalid_message", message: "Failed to parse message" });
        return;
      }

      if (msg.type === "pong") {
        await updateLastPing(userId, msg.ts);
        return;
      }

      if (msg.type === "module_request") {
        try {
          const result = await dispatch(userId, sessionId, msg.module, msg.action, msg.payload);
          send(ws, { type: "module_response", module: msg.module, action: msg.action, payload: result });
        } catch (err) {
          send(ws, { type: "error", code: "command_error", message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "relay") {
        sessionRegistry.relay(sessionId, userId, msg.target, msg.payload);
        return;
      }
    },

    async onClose() {
      if (pingTimer) clearInterval(pingTimer);
      sessionRegistry.unregister(sessionId);
      await updateUserStateField(userId, "session_expired");
    },
  };
}

// ── ゲストセッション ─────────────────────────────────────────

export function createGuestWsHandler(): WSEvents {
  const guestSessionId = `guest_${crypto.randomUUID()}`;
  let promoted = false;
  let promotedUserId = "";
  let promotedSessionId = "";
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  return {
    onOpen(_evt, ws) {
      send(ws, { type: "guest_connected", session_id: guestSessionId });
    },

    async onMessage(evt, ws) {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(typeof evt.data === "string" ? evt.data : evt.data.toString());
      } catch {
        send(ws, { type: "error", code: "invalid_message", message: "Failed to parse message" });
        return;
      }

      // 昇格済み → 認証済みとして処理
      if (promoted) {
        if (msg.type === "pong") {
          await updateLastPing(promotedUserId, msg.ts);
          return;
        }
        if (msg.type === "module_request") {
          try {
            const result = await dispatch(promotedUserId, promotedSessionId, msg.module, msg.action, msg.payload);
            send(ws, { type: "module_response", module: msg.module, action: msg.action, payload: result });
          } catch (err) {
            send(ws, { type: "error", code: "command_error", message: (err as Error).message });
          }
          return;
        }
        if (msg.type === "relay") {
          sessionRegistry.relay(promotedSessionId, promotedUserId, msg.target, msg.payload);
          return;
        }
        return;
      }

      // ゲスト: auth モジュールのみ
      if (msg.type === "pong") return;

      if (msg.type === "relay") {
        send(ws, { type: "error", code: "guest_restricted", message: "Guest sessions cannot use relay" });
        return;
      }

      if (msg.type === "module_request") {
        if (msg.module !== "auth") {
          send(ws, {
            type: "error",
            code: "guest_restricted",
            message: `Guest sessions can only use 'auth' module. Got '${msg.module}'`,
          });
          return;
        }

        try {
          const result = await handleGuestAuthCommand(msg.action, msg.payload);

          // 昇格条件チェック
          if (result.userId && result.accessToken && result.refreshToken) {
            const newSessionId = crypto.randomUUID();
            const now = Date.now();

            await putSession({
              id: newSessionId,
              userId: result.userId,
              expiresAt: new Date(now + SESSION_TTL_SECS * 1000).toISOString(),
              accessToken: result.accessToken,
            });

            sessionRegistry.register(newSessionId, result.userId, ws);

            const userState: UserFullState = {
              userId: result.userId,
              sessionId: newSessionId,
              state: "logged_in",
              modules: [],
              lastPingAt: Math.floor(now / 1000),
            };
            await setUserState(userState);

            send(ws, {
              type: "authenticated",
              session_id: newSessionId,
              user_state: userState,
              access_token: result.accessToken,
              refresh_token: result.refreshToken,
            });

            promoted = true;
            promotedUserId = result.userId;
            promotedSessionId = newSessionId;

            pingTimer = setInterval(() => {
              send(ws, { type: "ping", ts: Math.floor(Date.now() / 1000) });
            }, PING_INTERVAL_MS);
          } else {
            // MFA チャレンジ等
            send(ws, { type: "module_response", module: "auth", action: msg.action, payload: result });
          }
        } catch (err) {
          send(ws, { type: "error", code: "auth_error", message: (err as Error).message });
        }
      }
    },

    async onClose() {
      if (pingTimer) clearInterval(pingTimer);
      if (promoted) {
        sessionRegistry.unregister(promotedSessionId);
        await updateUserStateField(promotedUserId, "session_expired");
      }
    },
  };
}

// ── WS 接続認証判定 ──────────────────────────────────────────

export async function resolveWsAuth(
  token?: string, sessionId?: string,
): Promise<{ userId: string; sessionId: string } | null> {
  if (sessionId) {
    const session = await getSession(sessionId);
    if (session && new Date(session.expiresAt) > new Date()) {
      return { userId: session.userId, sessionId: session.id };
    }
  }

  if (token) {
    try {
      const claims = verifyToken(token);
      const newSessionId = crypto.randomUUID();
      await putSession({
        id: newSessionId,
        userId: claims.sub,
        expiresAt: new Date(Date.now() + SESSION_TTL_SECS * 1000).toISOString(),
        accessToken: token,
      });
      return { userId: claims.sub, sessionId: newSessionId };
    } catch {
      return null;
    }
  }

  return null;
}
