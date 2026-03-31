/**
 * 認証ミドルウェア
 */

import { createMiddleware } from "hono/factory";
import jwt from "jsonwebtoken";
import type { IdSecretManager, UserRole } from "./types.js";

export function requireRole(...allowedRoles: UserRole[]) {
  return createMiddleware(async (c, next) => {
    const role = (c.get("userRole" as never) as UserRole) || "general";

    if (!allowedRoles.includes(role)) {
      return c.json(
        {
          error: "Forbidden",
          message: `Role '${role}' is not authorized for this operation`,
          requiredRoles: allowedRoles,
        },
        403,
      );
    }

    await next();
  });
}

export function createUserContext(jwtSecret: string, secretManager: IdSecretManager) {
  const isProduction = secretManager.getOrDefault("NODE_ENV", "development") === "production";

  return createMiddleware(async (c, next) => {
    const authHeader = c.req.header("Authorization");

    if (authHeader?.startsWith("Bearer ")) {
      try {
        const token = authHeader.slice(7);
        const payload = jwt.verify(token, jwtSecret) as { userId: string; role: string };
        c.set("userId" as never, payload.userId as never);
        c.set("userRole" as never, payload.role as never);
      } catch {
        c.set("userId" as never, "anonymous" as never);
        c.set("userRole" as never, "general" as never);
      }
    } else if (!isProduction) {
      const userId = c.req.header("X-User-Id") || "anonymous";
      const role = (c.req.header("X-User-Role") as UserRole) || "general";
      c.set("userId" as never, userId as never);
      c.set("userRole" as never, role as never);
    } else {
      c.set("userId" as never, "anonymous" as never);
      c.set("userRole" as never, "general" as never);
    }

    await next();
  });
}
