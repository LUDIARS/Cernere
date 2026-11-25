import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../error.js";
import { extractBearerToken, verifyToken } from "../auth/jwt.js";
import { resolveAuthCodeBinding } from "../auth/composite-redirect.js";
import { issueAuthCodeForUserId } from "../auth/auth-code.js";
import { beginMfaChallenge, verifyMfaChallenge } from "../auth/mfa-challenge.js";
import { readMfaTicket } from "../auth/mfa-records.js";
import { loadMfaUser } from "../auth/mfa-user.js";
import { startOnsiteChallenge } from "../auth/onsite-challenge.js";
import { projectOnsiteRequirement } from "../project/onsite-mfa-policy.js";
import { ConsentRequiredError, consentRequiredBody } from "../consent/gate.js";

const requestSchema = z.object({
  client_id: z.string().min(1).max(512), target: z.string().url().max(2048),
  targetMode: z.enum(["post_message", "redirect"]), state: z.string().regex(/^[A-Za-z0-9_-]{32,512}$/),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/** This is a step-up from an existing Cernere session. The kiosk cannot choose the browser's subject. */
export async function compositeOnsite(action: "available" | "begin" | "finish", auth: string, body: unknown): Promise<unknown> {
  const token = extractBearerToken(auth);
  if (!token) throw AppError.unauthorized("Cernere session required");
  const source = await verifyToken(token);
  const parsed = requestSchema.extend({ mfaToken: z.string().max(128).optional() }).strict().safeParse(body);
  if (!parsed.success) throw AppError.badRequest("Invalid onsite login request");
  const { mfaToken, ...request } = parsed.data;
  const binding = await resolveAuthCodeBinding(request, {});
  if (binding.audience !== "service" || binding.projectKey !== "glab") {
    if (action === "available") return { available: false };
    throw AppError.forbidden("Onsite login is unavailable for this service");
  }
  const requirement = await projectOnsiteRequirement(binding.projectKey);
  if (action === "available") return { available: requirement !== null };
  if (!requirement) throw AppError.forbidden("Onsite login is not enabled for this service");
  const digest = createHash("sha256").update(JSON.stringify(["composite-onsite", token, request.client_id,
    request.target, request.targetMode, request.state, request.code_challenge])).digest("hex");
  const context = { purpose: "composite" as const, binding: digest, projectKey: binding.projectKey };
  if (action === "begin") {
    const result = await beginMfaChallenge(await loadMfaUser(source.sub), context, requirement);
    return { mfaToken: result.mfaToken, ...await startOnsiteChallenge(result.mfaToken) };
  }
  if (!mfaToken) throw AppError.badRequest("Onsite ticket required");
  const ticket = await readMfaTicket(mfaToken, context);
  if (ticket.record.userId !== source.sub || !ticket.record.onsite
      || ticket.record.onsite.minAssurance !== requirement.minAssurance
      || JSON.stringify(ticket.record.onsite.allowedPlaceIds) !== JSON.stringify(requirement.allowedPlaceIds)) {
    throw AppError.forbidden("Onsite login no longer matches the current service policy");
  }
  try {
    await verifyMfaChallenge(mfaToken, "onsite", "", context, async user => {
      if (user.id !== source.sub) throw AppError.forbidden("Onsite login subject mismatch");
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "onsite_pending") return { pending: true };
    throw error;
  }
  try {
    const authCode = await issueAuthCodeForUserId(source.sub, { subject: { projectKey: binding.projectKey },
      authCodeBinding: binding, channel: "browser",
      continuation: { mode: request.targetMode, target: request.target, state: request.state } }, source);
    if (!authCode) throw AppError.unauthorized("Cernere session expired");
    return { authCode };
  } catch (error) {
    if (error instanceof ConsentRequiredError) return consentRequiredBody(error);
    throw error;
  }
}
