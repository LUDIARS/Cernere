/** REST の bearer から利用者を特定する (passkey / リカバリー QR の認証済み入口で共通)。 */

import { extractBearerToken, verifyToken } from "../auth/jwt.js";

export async function requireUserId(authHeader: string): Promise<{ id: string; role: string; token: string }> {
  const token = extractBearerToken(authHeader);
  if (!token) throw new Error("Unauthorized: missing bearer token");
  const payload = await verifyToken(token);
  if (!payload || typeof payload.sub !== "string") {
    throw new Error("Unauthorized: invalid token");
  }
  return { id: payload.sub, role: (payload.role as string) || "general", token };
}
