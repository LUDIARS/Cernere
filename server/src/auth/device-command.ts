/** Connected-session device management; action proofs are enforced by WS. @implements SPEC-DEVICE-REVOCATION */
import { z } from "zod";
import { AppError } from "../error.js";
import { config } from "../config.js";
import { getSession } from "../redis.js";
import { listDeviceCredentials, revokeDeviceCredential, revokeAllDeviceCredentials } from "./device-credential.js";

export async function deviceSessionCommand(userId: string, sessionId: string, action: string, payload: unknown): Promise<unknown> {
  if (action === "list") return { enabled: config.deviceSessionsEnabled, currentDeviceId: (await getSession(sessionId))?.authorization?.deviceId, devices: await listDeviceCredentials(userId) };
  if (action === "revoke_all") return { revoked: await revokeAllDeviceCredentials({ userId, reason: "logout" }) };
  if (action === "revoke") {
    const parsed = z.object({ deviceId: z.string().uuid() }).strict().safeParse(payload);
    if (!parsed.success) throw AppError.badRequest("Invalid device selection");
    return { revoked: await revokeDeviceCredential({ userId, deviceId: parsed.data.deviceId, reason: "logout" }) };
  }
  throw AppError.badRequest("Unknown device session action");
}
