/** Admin transport for enterprise connection configuration. @implements SPEC-ENTERPRISE-ADMIN */
import { z } from "zod";
import { AppError } from "../error.js";
import { devError } from "../logging/dev-logger.js";
import { listEnterpriseConfiguration, saveConnection, saveEnterpriseIdentity, revokeEnterpriseUser } from "./connections.js";

export async function enterpriseAdminCommand(action: string, payload: unknown): Promise<unknown> {
  try {
    switch (action) {
      case "list": return await listEnterpriseConfiguration();
      case "save_connection": return await saveConnection(payload);
      case "save_identity": await saveEnterpriseIdentity(payload); return { saved: true };
      case "revoke_user": {
        const parsed = z.object({ projectKey: z.string().min(1).max(128), userId: z.string().uuid() }).strict().safeParse(payload);
        if (!parsed.success) throw AppError.badRequest("Select the project and user to revoke");
        return { revoked: await revokeEnterpriseUser(parsed.data.projectKey, parsed.data.userId) };
      }
      default: throw AppError.badRequest("Unknown enterprise administration action");
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    // The admin only sees a generic message; keep the real cause server-side so an
    // unexpected failure is not indistinguishable from a rejected registration.
    devError("enterprise.admin.failed", error, { action });
    throw AppError.serviceUnavailable("Enterprise configuration could not be saved or loaded. Reload and check the selected registrations.");
  }
}
