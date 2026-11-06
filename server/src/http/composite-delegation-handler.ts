/** Source and destination authenticate independently; neither can widen an operation.
 * @implements SPEC-COMPOSITE-DELEGATION
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/connection.js";
import { managedProjects } from "../db/schema.js";
import { redis, checkRateLimit } from "../redis.js";
import { AppError } from "../error.js";
import { ActionProofStore } from "../auth/action-proof.js";
import { CompositeDelegationStore, delegatedEnvelope, delegatedOperationSchema, type DelegationRecord } from "../auth/composite-delegation-store.js";
import { currentCompositeSession, currentCompositeProject, currentStoredCompositeSession, type CompositeSessionContext } from "../auth/composite-session.js";
import { requireCompositeOperation } from "../auth/composite-operation-permission.js";
import { registeredHubUrl } from "../auth/composite-redirect.js";
import { getProjectUserPermissions } from "../project/user-permissions.js";
import { getConsentRecord } from "../consent/store.js";
import { serviceUserView } from "../auth/service-user-view.js";
import { logAuthEvent } from "../logging/auth-logger.js";

const requestSchema = delegatedOperationSchema.safeExtend({ projectToken: z.string().min(1).max(16_384),
  sessionBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/), targetProject: z.string().min(1).max(128), targetAudience: z.string().url() }).strict();
const consumeSchema = delegatedOperationSchema.safeExtend({ delegationToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const store = new CompositeDelegationStore(redis, new ActionProofStore({ redisClient: redis, ttlSeconds: 30 }));

async function destination(project: typeof managedProjects.$inferSelect, source: CompositeSessionContext, action: string) {
  if (!project.isActive || project.key === source.project.key) throw AppError.forbidden("Invalid delegation destination");
  const [consent, permissions] = await Promise.all([
    getConsentRecord(source.identity.subject, { kind: "project", key: project.key }),
    getProjectUserPermissions(project.key, source.identity.subject),
  ]);
  if (!consent || consent.revoked) throw AppError.forbidden("Destination consent is required");
  const policy = requireCompositeOperation({ project, consent, permissions: permissions.permissions }, action, true);
  if (!permissions.permissions.some(permission => permission.key === "identity.basic" && permission.allowed)) throw AppError.forbidden("Destination access is not granted");
  return { consent, permissions: permissions.permissions, policy, audience: registeredHubUrl(project.schemaDefinition, project.key) };
}
function sourcePolicy(context: CompositeSessionContext, targetKey: string, action: string, risk: string): void {
  const policy = requireCompositeOperation(context, `delegate.${targetKey}.${action}`, true);
  if (policy.risk !== risk) throw AppError.forbidden("Delegation risk classification differs between services");
}

export async function handleCompositeDelegationRoute(action: "delegate" | "consume-delegation", raw: unknown, authHeader: string): Promise<{ status: string; data: unknown }> {
  if (action === "delegate") {
    const input = requestSchema.safeParse(raw);
    if (!input.success) throw AppError.badRequest("Invalid delegation request");
    const request = input.data;
    const source = await currentCompositeSession(request, authHeader);
    await checkRateLimit(`service-delegation:${source.project.key}:${source.identity.subject}`, 300, 60);
    const target = (await db.select().from(managedProjects).where(eq(managedProjects.key, request.targetProject)).limit(1))[0];
    if (!target) throw AppError.forbidden("Invalid delegation destination");
    const resolved = await destination(target, source, request.action);
    if (resolved.audience !== request.targetAudience) throw AppError.forbidden("Delegation audience differs from the registered destination");
    sourcePolicy(source, target.key, request.action, resolved.policy.risk);
    const now = Date.now();
    const record: DelegationRecord = { version: 1,
      source: { projectKey: source.project.key, audience: source.grant.audience, credentialGeneration: source.project.credentialGeneration,
        grantId: source.grantId, sessionBinding: request.sessionBinding, userId: source.grant.source.sub, subjectId: source.identity.subject, expiresAt: source.expiresAt },
      target: { projectKey: target.key, audience: resolved.audience, credentialGeneration: target.credentialGeneration, consentRevision: resolved.consent.decidedAt },
      operation: delegatedEnvelope(request), risk: resolved.policy.risk, issuedAt: now, expiresAt: Math.min(source.expiresAt, now + 30_000) };
    const ttl = Math.ceil((source.expiresAt - now) / 1000);
    if (ttl < 1) throw AppError.unauthorized("Service session expired");
    if (await redis.set(`composite-delegation-request:${source.grantId}:${request.requestId}`, "attempted", "EX", ttl, "NX") !== "OK") {
      throw AppError.withCode(409, "operation_already_attempted", "Delegation request was already attempted");
    }
    const delegationToken = await store.issue(record);
    logAuthEvent({ event: "service.operation.authorized", phase: "delegate", projectKey: source.project.key,
      userId: source.identity.subject, action: request.action, requestId: request.requestId });
    return { status: "200 OK", data: { delegationToken, requestId: request.requestId, expiresAt: new Date(record.expiresAt).toISOString() } };
  }
  const input = consumeSchema.safeParse(raw);
  if (!input.success) throw AppError.badRequest("Invalid delegated operation");
  const request = input.data;
  const target = await currentCompositeProject(authHeader);
  await checkRateLimit(`service-delegation-consume:${target.key}`, 1000, 60);
  const record = await store.read(request.delegationToken);
  if (record.target.projectKey !== target.key || record.target.credentialGeneration !== target.credentialGeneration
    || record.target.audience !== registeredHubUrl(target.schemaDefinition, target.key)
    || JSON.stringify(record.operation) !== JSON.stringify(delegatedEnvelope(request))) {
    throw AppError.forbidden("Delegation does not match this destination or operation");
  }
  const source = await currentStoredCompositeSession(record.source.grantId, record.source.sessionBinding);
  if (source.project.key !== record.source.projectKey || source.project.credentialGeneration !== record.source.credentialGeneration
    || source.grant.audience !== record.source.audience || source.grant.source.sub !== record.source.userId
    || source.identity.subject !== record.source.subjectId || record.source.expiresAt <= Date.now()) throw AppError.forbidden("Delegation source changed");
  const resolved = await destination(target, source, request.action);
  if (resolved.consent.decidedAt !== record.target.consentRevision || resolved.policy.risk !== record.risk) throw AppError.forbidden("Destination authorization changed");
  sourcePolicy(source, target.key, request.action, record.risk);
  await store.consume(request.delegationToken, record);
  logAuthEvent({ event: "service.operation.consumed", phase: "delegation", projectKey: target.key,
    userId: source.identity.subject, action: request.action, requestId: request.requestId });
  return { status: "200 OK", data: { allowed: true, requestId: request.requestId, projectKey: target.key,
    sourceProject: source.project.key, risk: record.risk, expiresAt: new Date(record.expiresAt).toISOString(), user: serviceUserView(source.identity, resolved.permissions) } };
}
