/** Two single-use boundaries preserve transfers without extending a capability.
 * @implements SPEC-COMPOSITE-UPLOAD-RESERVATION
 */
import { z } from "zod";
import { redis, checkRateLimit } from "../redis.js";
import { AppError } from "../error.js";
import { ActionProofStore } from "../auth/action-proof.js";
import { delegatedEnvelope, delegatedOperationSchema } from "../auth/composite-delegation-store.js";
import { CompositeUploadStore } from "../auth/composite-upload-store.js";
import { uploadLimitsSchema, type UploadTarget } from "../auth/composite-upload-record.js";
import { currentCompositeProject } from "../auth/composite-session.js";
import { currentDelegationAuthority } from "../auth/composite-delegation-policy.js";
import { registeredHubUrl } from "../auth/composite-redirect.js";
import { serviceUserView } from "../auth/service-user-view.js";
import { MAX_UPLOAD_BYTES } from "../project/service-operation-policy.js";
import { logAuthEvent } from "../logging/auth-logger.js";
import { issueCompositeUpload } from "./composite-upload-issue.js";

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const beginSchema = z.object({ arrivalToken: opaque, requestBinding: opaque, limits: uploadLimitsSchema, risk: z.literal("important"),
  action: delegatedOperationSchema.shape.action, method: delegatedOperationSchema.shape.method, path: delegatedOperationSchema.shape.path,
  resource: delegatedOperationSchema.shape.resource, headersDigest: opaque, requestId: z.string().uuid() }).strict();
const finishSchema = delegatedOperationSchema.safeExtend({ receipt: opaque, requestBinding: opaque,
  byteLength: z.number().int().positive().max(MAX_UPLOAD_BYTES), risk: z.literal("important") }).strict();
const cancelSchema = z.object({ receipt: opaque, requestBinding: opaque }).strict();
const store = new CompositeUploadStore(redis, new ActionProofStore({ redisClient: redis, ttlSeconds: 30 }));
export type CompositeUploadAction = "delegate-upload" | "begin-upload" | "finalize-upload" | "cancel-upload";

/** @implements SPEC-COMPOSITE-UPLOAD-RESERVATION */
export async function handleCompositeUploadRoute(action: CompositeUploadAction, raw: unknown, authHeader: string): Promise<{ status: string; data: unknown }> {
  if (action === "delegate-upload") return issueCompositeUpload(raw, authHeader, store);
  const project = await currentCompositeProject(authHeader);
  await checkRateLimit(`service-upload-target:${project.key}`, 1000, 60);
  const target = (requestBinding: string): UploadTarget => ({ projectKey: project.key, credentialGeneration: project.credentialGeneration,
    audience: registeredHubUrl(project.schemaDefinition, project.key), requestBinding });
  if (action === "cancel-upload") {
    const parsed = cancelSchema.safeParse(raw);
    if (!parsed.success) throw AppError.badRequest("Invalid upload cancellation");
    await store.cancel(parsed.data.receipt, target(parsed.data.requestBinding));
    return { status: "200 OK", data: { cancelled: true } };
  }
  if (action === "begin-upload") {
    const parsed = beginSchema.safeParse(raw);
    if (!parsed.success) throw AppError.badRequest("Invalid upload reservation");
    const request = parsed.data, arrival = await store.readArrival(request.arrivalToken);
    const operation = delegatedEnvelope({ action: request.action, method: request.method, path: request.path, resource: request.resource,
      headersDigest: request.headersDigest, requestId: request.requestId, contentDigest: arrival.delegation.operation.contentDigest });
    if (JSON.stringify(operation) !== JSON.stringify(arrival.delegation.operation)) throw AppError.forbidden("Upload request differs from the authorized operation");
    const { resolved } = await currentDelegationAuthority(arrival.delegation, project);
    if (!resolved.policy.upload || resolved.policy.risk !== "important") throw AppError.forbidden("Upload operation is not classified");
    const limits = { maximumBytes: Math.min(resolved.policy.upload.maximumBytes, request.limits.maximumBytes),
      timeoutSeconds: Math.min(resolved.policy.upload.timeoutSeconds, request.limits.timeoutSeconds) };
    const { receipt, reservation } = await store.begin(request.arrivalToken, arrival, target(request.requestBinding), limits);
    return { status: "200 OK", data: { receipt, requestId: operation.requestId, risk: "important", byteLength: arrival.byteLength,
      contentDigest: operation.contentDigest, limits: reservation.limits, expiresAt: new Date(reservation.deadline).toISOString() } };
  }
  const parsed = finishSchema.safeParse(raw);
  if (!parsed.success) throw AppError.badRequest("Invalid upload completion");
  const request = parsed.data;
  // Burn before every later authority/data validation. Failure never implies retry.
  const reservation = await store.consume(request.receipt, target(request.requestBinding));
  const record = reservation.arrival.delegation;
  if (request.byteLength !== reservation.arrival.byteLength || JSON.stringify(delegatedEnvelope(request)) !== JSON.stringify(record.operation)) {
    throw AppError.forbidden("Completed upload differs from the reserved operation");
  }
  const { source, resolved } = await currentDelegationAuthority(record, project);
  if (!resolved.policy.upload || resolved.policy.risk !== "important" || request.byteLength > resolved.policy.upload.maximumBytes
    || Date.now() >= reservation.begunAt + resolved.policy.upload.timeoutSeconds * 1000) throw AppError.forbidden("Upload policy changed");
  logAuthEvent({ event: "service.operation.consumed", phase: "upload", projectKey: project.key,
    userId: source.identity.subject, action: request.action, requestId: request.requestId });
  return { status: "200 OK", data: { allowed: true, requestId: request.requestId, projectKey: project.key, sourceProject: source.project.key,
    risk: "important", expiresAt: new Date(reservation.deadline).toISOString(), user: serviceUserView(source.identity, resolved.permissions) } };
}
