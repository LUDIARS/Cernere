/**
 * WebSocket メッセージプロトコル型定義
 */

import type { UserFullState } from "../redis.js";

// ── Client → Server ──────────────────────────────────────────

export type ClientMessage =
  | { type: "pong"; ts: number }
  | { type: "module_request"; module: string; action: string; payload?: unknown }
  | { type: "relay"; target: RelayTarget; payload: unknown };

export type RelayTarget =
  | "broadcast"
  | { user: string }
  | { session: string };

// ── Server → Client ──────────────────────────────────────────

export type ServerMessage =
  | { type: "connected"; session_id: string; user_state: UserFullState }
  | { type: "guest_connected"; session_id: string }
  | { type: "authenticated"; session_id: string; user_state: UserFullState; access_token: string; refresh_token: string }
  | { type: "ping"; ts: number }
  | { type: "state_changed"; user_state: UserFullState }
  | { type: "module_response"; module: string; action: string; payload: unknown }
  | { type: "relayed"; from_session: string; payload: unknown }
  | { type: "error"; code: string; message: string };
