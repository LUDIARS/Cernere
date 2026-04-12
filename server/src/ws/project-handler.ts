/**
 * プロジェクト WebSocket ハンドラ
 *
 * Schedula 等の外部サービスがプロジェクト認証 (client_credentials) 経由で
 * Cernere に WebSocket 接続し、ユーザープロファイル等を取得する。
 *
 * 接続: GET /ws/project?token=<project_jwt>
 * 認証: /api/auth/login (grant_type: "project_credentials") で発行された JWT
 *
 * プロトコル:
 *   C→S: { type: "module_request", module, action, payload }
 *   S→C: { type: "module_response", module, action, payload }
 *   S→C: { type: "error", code, message }
 */

import type uWS from "uWebSockets.js";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { verifyProjectToken, type ProjectJwtClaims } from "../auth/jwt.js";

export interface ProjectWsUserData {
  clientId: string;
  projectKey: string;
  connectionId: string;
}

interface ClientMessage {
  type: string;
  module?: string;
  action?: string;
  payload?: Record<string, unknown>;
  ts?: number;
}

interface ServerMessage {
  type: "connected" | "module_response" | "error" | "ping" | "pong";
  [key: string]: unknown;
}

const PING_INTERVAL_MS = 30_000;
const pingTimers = new Map<string, ReturnType<typeof setInterval>>();

function send(ws: uWS.WebSocket<ProjectWsUserData>, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

/**
 * upgrade 時にプロジェクトトークンを検証。
 * 成功時にプロジェクト情報を返し、失敗時は null。
 */
export async function resolveProjectWsAuth(
  token?: string,
): Promise<ProjectJwtClaims | null> {
  if (!token) return null;
  try {
    const claims = verifyProjectToken(token);
    // プロジェクトが有効か DB で確認
    const rows = await db.select({ isActive: schema.managedProjects.isActive })
      .from(schema.managedProjects)
      .where(eq(schema.managedProjects.clientId, claims.sub))
      .limit(1);
    if (!rows[0] || !rows[0].isActive) return null;
    return claims;
  } catch {
    return null;
  }
}

// ── open ──────────────────────────────────────────────────

export function handleProjectWsOpen(ws: uWS.WebSocket<ProjectWsUserData>): void {
  const data = ws.getUserData();
  send(ws, {
    type: "connected",
    connection_id: data.connectionId,
    project_key: data.projectKey,
    client_id: data.clientId,
  });

  const timer = setInterval(() => {
    send(ws, { type: "ping", ts: Math.floor(Date.now() / 1000) });
  }, PING_INTERVAL_MS);
  pingTimers.set(data.connectionId, timer);
}

// ── message ───────────────────────────────────────────────

export async function handleProjectWsMessage(
  ws: uWS.WebSocket<ProjectWsUserData>,
  message: ArrayBuffer,
): Promise<void> {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(Buffer.from(message).toString());
  } catch {
    send(ws, { type: "error", code: "invalid_message", message: "Failed to parse message" });
    return;
  }

  if (msg.type === "pong") return;

  if (msg.type === "module_request" && msg.module && msg.action) {
    try {
      const { dispatchProjectCommand } = await import("./project-dispatch.js");
      const data = ws.getUserData();
      const result = await dispatchProjectCommand(
        data.projectKey,
        msg.module,
        msg.action,
        msg.payload ?? {},
      );
      send(ws, {
        type: "module_response",
        module: msg.module,
        action: msg.action,
        payload: result,
      });
    } catch (err) {
      send(ws, {
        type: "error",
        code: "command_error",
        message: (err as Error).message,
        module: msg.module,
        action: msg.action,
      });
    }
  }
}

// ── close ─────────────────────────────────────────────────

export function handleProjectWsClose(ws: uWS.WebSocket<ProjectWsUserData>): void {
  const data = ws.getUserData();
  const timer = pingTimers.get(data.connectionId);
  if (timer) {
    clearInterval(timer);
    pingTimers.delete(data.connectionId);
  }
}
