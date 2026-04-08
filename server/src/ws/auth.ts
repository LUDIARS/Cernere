/**
 * WS 接続認証判定 (フレームワーク非依存)
 */

import { verifyToken } from "../auth/jwt.js";
import { putSession, getSession, SESSION_TTL_SECS } from "../redis.js";

export async function resolveWsAuth(
  token?: string,
  sessionId?: string,
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
