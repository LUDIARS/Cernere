/**
 * WebSocket ハンドラ (uWebSockets.js 版)
 *
 * app.ts の ws<WsUserData> から呼ばれる open/message/close コールバック。
 */

import type uWS from "uWebSockets.js";
import type { WsUserData } from "../app.js";
import {
  setUserState, updateLastPing, updateUserStateField,
  putSession, SESSION_TTL_SECS, type UserFullState,
} from "../redis.js";
import { sessionRegistry } from "./session-registry.js";
import { dispatch } from "../commands.js";
import { handleGuestAuthCommand } from "./guest.js";
import { notifyPresenceChange } from "./events.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";
import { logUserWsConnect, logUserWsDisconnect } from "../logging/auth-logger.js";

const PING_INTERVAL_MS = 30_000;

const pingTimers = new Map<string, ReturnType<typeof setInterval>>();

/**
 * Safe send — close 後のソケットに触ると uWS は throw するので、
 * userData.closed フラグで早期リターン + try/catch で二重防御する。
 * この関数は例外を投げない (logging のみ)。
 */
function send(ws: uWS.WebSocket<WsUserData>, msg: ServerMessage): void {
  let data: WsUserData | undefined;
  try {
    data = ws.getUserData();
  } catch {
    // 既に破棄された WebSocket
    return;
  }
  if (data.closed) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // close と send のレース。以降の send をブロックするため closed を立てる
    data.closed = true;
  }
}

// ── open ──────────────────────────────────────────────────

export async function handleWsOpen(ws: uWS.WebSocket<WsUserData>): Promise<void> {
  const data = ws.getUserData();

  if (data.isGuest) {
    send(ws, { type: "guest_connected", session_id: data.sessionId });
    return;
  }

  sessionRegistry.register(data.sessionId, data.userId, ws);

  const now = Date.now();
  const userState: UserFullState = {
    userId: data.userId,
    sessionId: data.sessionId,
    state: "logged_in",
    modules: [],
    lastPingAt: Math.floor(now / 1000),
  };
  await setUserState(userState);

  send(ws, { type: "connected", session_id: data.sessionId, user_state: userState });
  logUserWsConnect(data.userId, data.sessionId);
  notifyPresenceChange(data.userId, "online").catch(() => {});

  const timer = setInterval(() => {
    send(ws, { type: "ping", ts: Math.floor(Date.now() / 1000) });
  }, PING_INTERVAL_MS);
  pingTimers.set(data.sessionId, timer);
}

// ── message ──────────────────────────────────────────────

export async function handleWsMessage(
  ws: uWS.WebSocket<WsUserData>,
  message: ArrayBuffer,
): Promise<void> {
  const data = ws.getUserData();

  let msg: ClientMessage;
  try {
    msg = JSON.parse(Buffer.from(message).toString());
  } catch {
    send(ws, { type: "error", code: "invalid_message", message: "Failed to parse message" });
    return;
  }

  // ── ゲスト (未昇格) ──
  if (data.isGuest && !data.promoted) {
    if (msg.type === "pong") return;
    if (msg.type === "relay") {
      send(ws, { type: "error", code: "guest_restricted", message: "Guest sessions cannot use relay" });
      return;
    }
    if (msg.type === "module_request") {
      if (msg.module !== "auth") {
        send(ws, { type: "error", code: "guest_restricted", message: `Guest sessions can only use 'auth' module. Got '${msg.module}'` });
        return;
      }
      try {
        const result = await handleGuestAuthCommand(msg.action, msg.payload);
        if (result.userId && result.accessToken && result.refreshToken) {
          const newSessionId = crypto.randomUUID();
          const now = Date.now();
          await putSession({
            id: newSessionId, userId: result.userId,
            expiresAt: new Date(now + SESSION_TTL_SECS * 1000).toISOString(),
            accessToken: result.accessToken,
          });
          data.userId = result.userId;
          data.sessionId = newSessionId;
          data.isGuest = false;
          data.promoted = true;
          sessionRegistry.register(newSessionId, result.userId, ws);
          const userState: UserFullState = {
            userId: result.userId, sessionId: newSessionId, state: "logged_in",
            modules: [], lastPingAt: Math.floor(now / 1000),
          };
          await setUserState(userState);
          send(ws, { type: "authenticated", session_id: newSessionId, user_state: userState, access_token: result.accessToken, refresh_token: result.refreshToken });
          const timer = setInterval(() => { send(ws, { type: "ping", ts: Math.floor(Date.now() / 1000) }); }, PING_INTERVAL_MS);
          pingTimers.set(newSessionId, timer);
        } else {
          send(ws, { type: "module_response", module: "auth", action: msg.action, payload: result });
        }
      } catch (err) {
        send(ws, { type: "error", code: "auth_error", message: (err as Error).message });
      }
    }
    return;
  }

  // ── 認証済み ──
  if (msg.type === "pong") {
    await updateLastPing(data.userId, msg.ts);
    return;
  }
  if (msg.type === "module_request") {
    try {
      const result = await dispatch(data.userId, data.sessionId, msg.module, msg.action, msg.payload);
      send(ws, { type: "module_response", module: msg.module, action: msg.action, payload: result });
    } catch (err) {
      send(ws, { type: "error", code: "command_error", message: (err as Error).message });
    }
    return;
  }
  if (msg.type === "relay") {
    sessionRegistry.relay(data.sessionId, data.userId, msg.target, msg.payload);
  }
}

// ── close ─────────────────────────────────────────────────

export async function handleWsClose(ws: uWS.WebSocket<WsUserData>): Promise<void> {
  const data = ws.getUserData();
  // 最優先: send() が走らないよう同期的にフラグを立てる。
  // これ以降の await 内で別経路 (setInterval 等) が send を試みても握り潰される。
  data.closed = true;
  const timer = pingTimers.get(data.sessionId);
  if (timer) { clearInterval(timer); pingTimers.delete(data.sessionId); }

  if (!data.isGuest || data.promoted) {
    sessionRegistry.unregister(data.sessionId);
    await updateUserStateField(data.userId, "session_expired");
    logUserWsDisconnect(data.userId, data.sessionId);
    if (!sessionRegistry.isOnline(data.userId)) {
      notifyPresenceChange(data.userId, "offline").catch(() => {});
    }
  }
}
