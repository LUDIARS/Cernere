/** Live service-session validation; never trusts delivery of revocation notifications. */
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { managedProjects } from "../db/schema.js";
import { AppError } from "../error.js";
import { redis } from "../redis.js";
import { extractBearerToken, verifyProjectToken } from "./jwt.js";
import { verifyProjectTokenPaseto } from "./paseto.js";
import { readCompositeGrant, COMPOSITE_GRANT_TTL_SECONDS, type CompositeGrant } from "./composite-grant.js";
import { CompositeSessionStore } from "./composite-session-store.js";
import { RedisCompositeSessionCommands } from "./composite-session-redis.js";
import { registeredHubUrl } from "./composite-redirect.js";
import { assertUserSessionCurrent } from "./user-session-state.js";
import { isCurrentProjectCredential } from "../project/project-credential-state.js";
import { requireServiceAccess, loadServiceIdentity } from "../federation/subject.js";
import { getConsentRecord } from "../consent/store.js";
import { getProjectUserPermissions } from "../project/user-permissions.js";

export const compositeSessionStore = new CompositeSessionStore(new RedisCompositeSessionCommands(redis));
export interface CompositeSessionInput { projectToken: string; sessionBinding: string }
export interface CompositeSessionContext {
  project: typeof managedProjects.$inferSelect;
  grant: CompositeGrant;
  grantId: string;
  identity: NonNullable<Awaited<ReturnType<typeof loadServiceIdentity>>>;
  consent: Awaited<ReturnType<typeof getConsentRecord>>;
  permissions: Awaited<ReturnType<typeof getProjectUserPermissions>>["permissions"];
  expiresAt: number;
}
const invalid = (): AppError => AppError.unauthorized("Service session is not valid");

/** @implements SPEC-COMPOSITE-OPERATION-GUARD */
export async function currentCompositeSession(input: CompositeSessionInput, authHeader: string, bound = true): Promise<CompositeSessionContext> {
  const project = await currentCompositeProject(authHeader);
  const audience = registeredHubUrl(project.schemaDefinition, project.key);
  let claims: Awaited<ReturnType<typeof verifyProjectTokenPaseto>>;
  try { claims = await verifyProjectTokenPaseto(input.projectToken, audience); } catch { throw invalid(); }
  if (claims.projectKey !== project.key || claims.compositeGrant?.version !== 1 || !claims.compositeGrant.id) throw invalid();
  const grantId = claims.compositeGrant.id;
  const grant = await readCompositeGrant(grantId);
  if (!grant || grant.subjectId !== claims.sub || grant.role !== claims.role) throw invalid();
  return validateCompositeSession(project, grant, grantId, input.sessionBinding, bound, Date.parse(claims.exp));
}

/** Authenticate the current service's own project credential. @implements SPEC-COMPOSITE-OPERATION-GUARD */
export async function currentCompositeProject(authHeader: string): Promise<typeof managedProjects.$inferSelect> {
  let credential: ReturnType<typeof verifyProjectToken>;
  try { credential = verifyProjectToken(extractBearerToken(authHeader) ?? ""); } catch { throw invalid(); }
  if (!await isCurrentProjectCredential(credential.sub, credential.projectKey, credential.credentialGeneration ?? 0)) throw invalid();
  const project = (await db.select().from(managedProjects).where(eq(managedProjects.clientId, credential.sub)).limit(1))[0];
  if (!project?.isActive || project.key !== credential.projectKey || project.clientId !== credential.sub
    || project.credentialGeneration !== (credential.credentialGeneration ?? 0)) throw invalid();
  return project;
}

/** Resolve only a Cr-owned delegation record's source reference, never a caller-supplied identity.
 * @implements SPEC-COMPOSITE-DELEGATION
 */
export async function currentStoredCompositeSession(grantId: string, sessionBinding: string): Promise<CompositeSessionContext> {
  const grant = await readCompositeGrant(grantId);
  if (!grant) throw invalid();
  const project = (await db.select().from(managedProjects).where(eq(managedProjects.key, grant.projectKey)).limit(1))[0];
  if (!project?.isActive) throw invalid();
  return validateCompositeSession(project, grant, grantId, sessionBinding, true, grant.issuedAt + COMPOSITE_GRANT_TTL_SECONDS * 1000);
}

async function validateCompositeSession(project: typeof managedProjects.$inferSelect, grant: CompositeGrant, grantId: string,
  sessionBinding: string, bound: boolean, tokenExpiresAt: number): Promise<CompositeSessionContext> {
  const audience = registeredHubUrl(project.schemaDefinition, project.key);
  if (grant.projectKey !== project.key || grant.audience !== audience) throw invalid();
  if (bound) await compositeSessionStore.requireBound(grantId, sessionBinding);
  await assertUserSessionCurrent(grant.source);
  await requireServiceAccess(grant.source.sub);
  const identity = await loadServiceIdentity(grant.source.sub);
  if (!identity || identity.subject !== grant.subjectId || identity.role !== grant.role) throw invalid();
  const consent = await getConsentRecord(identity.subject, { kind: "project", key: project.key });
  if (consent?.revoked || (consent?.decidedAt ?? null) !== grant.consentRevision) throw invalid();
  const permissions = await getProjectUserPermissions(project.key, identity.subject);
  if (!permissions.permissions.some(permission => permission.key === "identity.basic" && permission.allowed)) throw invalid();
  const expiresAt = Math.min(tokenExpiresAt, grant.issuedAt + COMPOSITE_GRANT_TTL_SECONDS * 1000);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw invalid();
  return { project, grant, grantId, identity, consent, permissions: permissions.permissions, expiresAt };
}
