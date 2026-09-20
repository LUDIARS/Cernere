/** HTTP guard for applications that require enterprise authorization. */
import type { EnterpriseSessionClient } from "./enterprise-client.js";

interface EnterpriseContext {
  req: { header: (name: string) => string | undefined };
  set: (key: string, value: unknown) => void;
  json: (data: unknown, status?: number) => Response;
}

export function createEnterpriseAuthMiddleware(client: EnterpriseSessionClient):
  (context: EnterpriseContext, next: () => Promise<void>) => Promise<Response | void> {
  return async (context, next) => {
    const header = context.req.header("Authorization");
    if (!header?.startsWith("Bearer ces_")) return context.json({ error: "enterprise_session_required" }, 401);
    try {
      const session = await client.verify(header.slice(7));
      context.set("enterpriseSession", session);
      context.set("userId", session.userId);
      context.set("organizationId", session.organizationId);
      context.set("organizationRole", session.organizationRole);
    } catch {
      return context.json({ error: "enterprise_session_invalid" }, 401);
    }
    // Application errors must propagate to the application's handler, not become authentication errors.
    await next();
  };
}
