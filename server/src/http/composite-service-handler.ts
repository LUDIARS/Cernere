import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../error.js";
import { redis, checkRateLimit } from "../redis.js";
import { ActionProofStore } from "../auth/action-proof.js";
import { currentCompositeSession, compositeSessionStore } from "../auth/composite-session.js";
import { requireCompositeOperation } from "../auth/composite-operation-permission.js";
import { logAuthEvent } from "../logging/auth-logger.js";
import { serviceUserView } from "../auth/service-user-view.js";

const sessionSchema = z.object({ projectToken: z.string().min(1).max(16_384), sessionBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const operationSchema = sessionSchema.extend({ action: z.string().min(2).max(128), resource: z.string().min(1).max(512),
  contentDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/), requestId: z.string().uuid(), permit: z.string().min(32).max(512).optional() }).strict();
const permits = new ActionProofStore({ redisClient: redis, ttlSeconds: 30 });

/** @implements SPEC-COMPOSITE-OPERATION-GUARD */
export async function handleCompositeServiceRoute(action: string, body: string, authHeader: string): Promise<{ status: string; data: unknown }> {
  try { return await serviceAuthorityRoute(action, body, authHeader); }
  catch (error) {
    logAuthEvent({ event: "service.operation.rejected", phase: ["bind", "check", "revoke", "authorize", "consume", "delegate", "consume-delegation"].includes(action) ? action : "unknown",
      reason: error instanceof AppError ? error.code ?? "denied" : "unavailable" });
    throw error;
  }
}

/** @implements SPEC-COMPOSITE-OPERATION-GUARD */
async function serviceAuthorityRoute(action: string, body: string, authHeader: string): Promise<{ status: string; data: unknown }> {
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { throw AppError.badRequest("Invalid JSON"); }
  if (action === "delegate" || action === "consume-delegation") {
    const { handleCompositeDelegationRoute } = await import("./composite-delegation-handler.js");
    return handleCompositeDelegationRoute(action, raw, authHeader);
  }
  if (action.startsWith("identity-")) {
    const { handleCompositeIdentityRoute } = await import("./composite-identity-handler.js");
    return handleCompositeIdentityRoute(action, raw, authHeader);
  }
  if (!["bind", "check", "revoke", "authorize", "consume"].includes(action)) throw AppError.notFound("Unknown service authority action");
  const operation = action === "authorize" || action === "consume";
  const parsed = (operation ? operationSchema : sessionSchema).safeParse(raw);
  if (!parsed.success) throw AppError.badRequest("Invalid service authority request");
  const input = parsed.data;
  const context = await currentCompositeSession(input, authHeader, action !== "bind");
  await checkRateLimit(`service-authority:${context.project.key}:${context.identity.subject}`, 300, 60);
  if (action === "bind") {
    await compositeSessionStore.bind(context.grantId, input.sessionBinding, Math.min(900, Math.ceil((context.expiresAt - Date.now()) / 1000)));
  }
  if (action === "revoke") {
    await compositeSessionStore.revoke(context.grantId, input.sessionBinding);
    return { status: "200 OK", data: { revoked: true } };
  }
  if (operation) {
    const target = operationSchema.parse(input);
    const policy = requireCompositeOperation(context, target.action);
    const expectation = {
      userId: context.grant.source.sub, binding: `service:${context.project.key}:${input.sessionBinding}`,
      action: "service.operation" as const,
      resource: createHash("sha256").update(JSON.stringify({ version: 1, project: context.project.key, grant: context.grantId,
        user: context.identity.subject, session: input.sessionBinding, action: target.action, risk: policy.risk, resource: target.resource,
        contentDigest: target.contentDigest, requestId: target.requestId }), "utf8").digest("base64url"),
    };
    if (action === "authorize") {
      const ttl = Math.min(900, Math.ceil((context.expiresAt - Date.now()) / 1000));
      if (ttl < 1) throw AppError.unauthorized("Service session expired");
      const reserved = await redis.set(`composite-operation:${context.grantId}:${target.requestId}`, expectation.resource, "EX", ttl, "NX");
      if (reserved !== "OK") throw AppError.withCode(409, "operation_already_attempted", "Service operation request was already attempted");
      const issued = await permits.issue(expectation);
      logAuthEvent({ event: "service.operation.authorized", projectKey: context.project.key, userId: context.identity.subject,
        action: target.action, requestId: target.requestId, resourceDigest: expectation.resource });
      return { status: "200 OK", data: { permit: issued.proof, expiresIn: issued.expiresIn, risk: policy.risk } };
    }
    await permits.consume(target.permit, expectation);
    logAuthEvent({ event: "service.operation.consumed", projectKey: context.project.key, userId: context.identity.subject,
      action: target.action, requestId: target.requestId, resourceDigest: expectation.resource });
    return { status: "200 OK", data: { allowed: true, requestId: target.requestId, risk: policy.risk } };
  }
  return { status: "200 OK", data: { user: serviceUserView(context.identity, context.permissions),
    projectKey: context.project.key, expiresAt: new Date(context.expiresAt).toISOString() } };
}
