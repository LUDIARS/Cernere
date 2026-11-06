/** Source authority for an exact, privately captured outgoing upload.
 * @implements SPEC-COMPOSITE-UPLOAD-RESERVATION
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/connection.js";
import { managedProjects } from "../db/schema.js";
import { redis, checkRateLimit } from "../redis.js";
import { AppError } from "../error.js";
import { delegatedEnvelope, delegatedOperationSchema } from "../auth/composite-delegation-store.js";
import { currentCompositeSession } from "../auth/composite-session.js";
import { destination, sourcePolicy } from "../auth/composite-delegation-policy.js";
import { MAX_UPLOAD_BYTES } from "../project/service-operation-policy.js";
import type { CompositeUploadStore } from "../auth/composite-upload-store.js";
import type { UploadArrival } from "../auth/composite-upload-record.js";
import { logAuthEvent } from "../logging/auth-logger.js";

const requestSchema = delegatedOperationSchema.safeExtend({ byteLength: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  projectToken: z.string().min(1).max(16_384), sessionBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  targetProject: z.string().min(1).max(128), targetAudience: z.string().url() }).strict();

/** @implements SPEC-COMPOSITE-UPLOAD-RESERVATION */
export async function issueCompositeUpload(raw: unknown, authHeader: string, store: CompositeUploadStore): Promise<{ status: string; data: unknown }> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw AppError.badRequest("Invalid upload delegation");
  const request = parsed.data, source = await currentCompositeSession(request, authHeader);
  await checkRateLimit(`service-delegation:${source.project.key}:${source.identity.subject}`, 300, 60);
  const target = (await db.select().from(managedProjects).where(eq(managedProjects.key, request.targetProject)).limit(1))[0];
  if (!target) throw AppError.forbidden("Invalid upload destination");
  const resolved = await destination(target, source, request.action);
  if (resolved.audience !== request.targetAudience || !resolved.policy.upload || resolved.policy.risk !== "important"
    || request.byteLength > resolved.policy.upload.maximumBytes) throw AppError.forbidden("Upload is outside the destination policy");
  sourcePolicy(source, target.key, request.action, "important");
  const now = Date.now();
  const arrival: UploadArrival = { version: 1, byteLength: request.byteLength, limits: resolved.policy.upload, delegation: { version: 1,
    source: { projectKey: source.project.key, audience: source.grant.audience, credentialGeneration: source.project.credentialGeneration,
      grantId: source.grantId, sessionBinding: request.sessionBinding, userId: source.grant.source.sub, subjectId: source.identity.subject, expiresAt: source.expiresAt },
    target: { projectKey: target.key, audience: resolved.audience, credentialGeneration: target.credentialGeneration, consentRevision: resolved.consent.decidedAt },
    operation: delegatedEnvelope(request), risk: "important", issuedAt: now, expiresAt: Math.min(source.expiresAt, now + 30_000) } };
  const ttl = Math.ceil((source.expiresAt - now) / 1000);
  if (ttl < 1 || await redis.set(`composite-delegation-request:${source.grantId}:${request.requestId}`, "attempted", "EX", ttl, "NX") !== "OK") {
    throw AppError.withCode(409, "operation_already_attempted", "Delegation request was already attempted");
  }
  const arrivalToken = await store.issue(arrival);
  logAuthEvent({ event: "service.operation.authorized", phase: "delegate-upload", projectKey: source.project.key,
    userId: source.identity.subject, action: request.action, requestId: request.requestId });
  return { status: "200 OK", data: { arrivalToken, requestId: request.requestId, expiresAt: new Date(arrival.delegation.expiresAt).toISOString() } };
}
