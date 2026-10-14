/** Operator actions are available only through a protected connected user WS. @implements SPEC-DEVICE-RECOVERY */
import { z } from "zod";
import { AppError } from "../error.js";
import { issueRecoveryGrant, revokeGrant } from "./registration-grant.js";
import { freezeRecoveryRequest } from "./recovery-request.js";

export async function recoveryCommand(actorUserId: string, action: string, payload: unknown): Promise<unknown> {
  if (action === "issue") {
    const parsed = z.object({ userId: z.string().uuid(), revokeAllExistingPasskeys: z.boolean(),
      revokePasskeyIds: z.array(z.string().uuid()).max(100).optional() }).strict().safeParse(payload);
    if (!parsed.success) throw AppError.badRequest("Invalid recovery selection");
    return issueRecoveryGrant({ subjectUserId: parsed.data.userId, createdByUserId: actorUserId,
      revokeAllExistingPasskeys: parsed.data.revokeAllExistingPasskeys, revokePasskeyIds: parsed.data.revokePasskeyIds });
  }
  if (action === "revoke") {
    const parsed = z.object({ grantId: z.string().uuid() }).strict().safeParse(payload);
    if (!parsed.success) throw AppError.badRequest("Invalid recovery selection");
    return { revoked: await revokeGrant(parsed.data.grantId, actorUserId) };
  }
  if (action === "freeze") {
    // 本人から「リカバリー QR を盗まれた」と申告があったときに、保留中の自己回復を止める。
    const parsed = z.object({ userId: z.string().uuid() }).strict().safeParse(payload);
    if (!parsed.success) throw AppError.badRequest("Invalid recovery selection");
    return freezeRecoveryRequest(actorUserId, parsed.data.userId);
  }
  throw AppError.badRequest("Unknown recovery action");
}
