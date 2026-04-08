/**
 * WebSocket セッションレジストリ (uWebSockets.js 版)
 */

import type uWS from "uWebSockets.js";
import type { WsUserData } from "../app.js";
import type { ServerMessage, RelayTarget } from "./protocol.js";

export interface RegisteredSession {
  sessionId: string;
  userId: string;
  ws: uWS.WebSocket<WsUserData>;
}

class SessionRegistry {
  private sessions = new Map<string, RegisteredSession>();
  private userSessions = new Map<string, Set<string>>();

  register(sessionId: string, userId: string, ws: uWS.WebSocket<WsUserData>): void {
    this.sessions.set(sessionId, { sessionId, userId, ws });
    if (!this.userSessions.has(userId)) {
      this.userSessions.set(userId, new Set());
    }
    this.userSessions.get(userId)!.add(sessionId);
  }

  unregister(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    const userSet = this.userSessions.get(session.userId);
    if (userSet) {
      userSet.delete(sessionId);
      if (userSet.size === 0) this.userSessions.delete(session.userId);
    }
  }

  get(sessionId: string): RegisteredSession | undefined {
    return this.sessions.get(sessionId);
  }

  getByUser(userId: string): RegisteredSession[] {
    const ids = this.userSessions.get(userId);
    if (!ids) return [];
    return [...ids].map((id) => this.sessions.get(id)).filter(Boolean) as RegisteredSession[];
  }

  isOnline(userId: string): boolean {
    const ids = this.userSessions.get(userId);
    return !!ids && ids.size > 0;
  }

  onlineUserIds(): string[] {
    return [...this.userSessions.keys()];
  }

  private send(ws: uWS.WebSocket<WsUserData>, msg: ServerMessage): void {
    ws.send(JSON.stringify(msg));
  }

  sendTo(sessionId: string, msg: ServerMessage): void {
    const session = this.sessions.get(sessionId);
    if (session) this.send(session.ws, msg);
  }

  sendToUser(userId: string, msg: ServerMessage): void {
    for (const session of this.getByUser(userId)) {
      this.send(session.ws, msg);
    }
  }

  broadcastToUsers(userIds: string[], msg: ServerMessage, excludeUserId?: string): void {
    for (const uid of userIds) {
      if (uid === excludeUserId) continue;
      this.sendToUser(uid, msg);
    }
  }

  relay(fromSessionId: string, fromUserId: string, target: RelayTarget, payload: unknown): void {
    const msg: ServerMessage = { type: "relayed", from_session: fromSessionId, payload };

    if (target === "broadcast") {
      for (const session of this.getByUser(fromUserId)) {
        if (session.sessionId !== fromSessionId) this.send(session.ws, msg);
      }
    } else if ("user" in target) {
      for (const session of this.getByUser(target.user)) {
        this.send(session.ws, msg);
      }
    } else if ("session" in target) {
      this.sendTo(target.session, msg);
    }
  }
}

export const sessionRegistry = new SessionRegistry();
