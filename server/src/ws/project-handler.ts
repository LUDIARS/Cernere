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
import { logProjectWsConnect, logProjectWsDisconnect } from "../logging/auth-logger.js";
import { addConnection, removeConnection } from "./project-registry.js";

export interface ProjectWsUserData {
  clientId: string;
  projectKey: string;
  connectionId: string;
  /** close 後の send を防ぐフラグ (uWS は閉じたソケット操作で throw) */
  closed: boolean;
}

interface ClientMessage {
  type: string;
  request_id?: string;
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
  let data: ProjectWsUserData | undefined;
  try {
    data = ws.getUserData();
  } catch {
    return;
  }
  if (data.closed) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    data.closed = true;
  }
}

/**
 * upgrade 時にプロジェクトトークンを検証 (4 層防御の Layer 1+4 相当).
 *
 *   1. JWT 検証 (HS256)
 *   2. クレームの projectKey と managed_projects のレコードが整合
 *   3. is_active = true
 *   4. (ある場合) DB の clientId 列と claim.sub が完全一致
 *
 * 失敗時は null を返し caller (app.ts upgrade) が 401 を返す.
 */
export async function resolveProjectWsAuth(
  token?: string,
): Promise<ProjectJwtClaims | null> {
  if (!token) return null;
  try {
    const claims = verifyProjectToken(token);
    // プロジェクトの DB レコードと突き合わせ. clientId / projectKey
    // のいずれかが managed_projects の値と食い違うトークンは拒否.
    const rows = await db.select({
      key: schema.managedProjects.key,
      clientId: schema.managedProjects.clientId,
      isActive: schema.managedProjects.isActive,
    })
      .from(schema.managedProjects)
      .where(eq(schema.managedProjects.clientId, claims.sub))
      .limit(1);
    const proj = rows[0];
    if (!proj) return null;
    if (!proj.isActive) return null;
    if (claims.projectKey && claims.projectKey !== proj.key) return null;
    return claims;
  } catch {
    return null;
  }
}

// ── open ──────────────────────────────────────────────────

export function handleProjectWsOpen(ws: uWS.WebSocket<ProjectWsUserData>): void {
  const data = ws.getUserData();
  addConnection(data.projectKey, data.connectionId, data.clientId);
  send(ws, {
    type: "connected",
    connection_id: data.connectionId,
    project_key: data.projectKey,
    client_id: data.clientId,
  });
  logProjectWsConnect(data.projectKey, data.clientId, data.connectionId);

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
        request_id: msg.request_id,
        module: msg.module,
        action: msg.action,
        payload: result,
      });
    } catch (err) {
      send(ws, {
        type: "error",
        request_id: msg.request_id,
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
  // 同期的にフラグを立てる (send() が走るレースを防ぐ)
  data.closed = true;
  const timer = pingTimers.get(data.connectionId);
  if (timer) {
    clearInterval(timer);
    pingTimers.delete(data.connectionId);
  }
  removeConnection(data.projectKey, data.connectionId);
  logProjectWsDisconnect(data.projectKey, data.clientId, data.connectionId);
}
