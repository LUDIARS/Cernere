/** Shared live source/destination authority, reused before and after bounded transfer.
 * @implements SPEC-COMPOSITE-DELEGATION SPEC-COMPOSITE-UPLOAD-RESERVATION
 */
import { AppError } from "../error.js";
import type { managedProjects } from "../db/schema.js";
import { registeredHubUrl } from "./composite-redirect.js";
import { currentStoredCompositeSession, type CompositeSessionContext } from "./composite-session.js";
import { requireCompositeOperation } from "./composite-operation-permission.js";
import { getProjectUserPermissions } from "../project/user-permissions.js";
import { getConsentRecord } from "../consent/store.js";
import type { DelegationRecord } from "./composite-delegation-store.js";

export async function destination(project: typeof managedProjects.$inferSelect, source: CompositeSessionContext, action: string) {
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
export function sourcePolicy(context: CompositeSessionContext, targetKey: string, action: string, risk: string): void {
  if (requireCompositeOperation(context, `delegate.${targetKey}.${action}`, true).risk !== risk) throw AppError.forbidden("Delegation risk classification differs between services");
}
export async function currentDelegationAuthority(record: DelegationRecord, target: typeof managedProjects.$inferSelect) {
  if (record.target.projectKey !== target.key || record.target.credentialGeneration !== target.credentialGeneration
    || record.target.audience !== registeredHubUrl(target.schemaDefinition, target.key)) throw AppError.forbidden("Delegation destination changed");
  const source = await currentStoredCompositeSession(record.source.grantId, record.source.sessionBinding);
  if (source.project.key !== record.source.projectKey || source.project.credentialGeneration !== record.source.credentialGeneration
    || source.grant.audience !== record.source.audience || source.grant.source.sub !== record.source.userId
    || source.identity.subject !== record.source.subjectId || record.source.expiresAt <= Date.now()) throw AppError.forbidden("Delegation source changed");
  const resolved = await destination(target, source, record.operation.action);
  if (resolved.consent.decidedAt !== record.target.consentRevision || resolved.policy.risk !== record.risk) throw AppError.forbidden("Destination authorization changed");
  sourcePolicy(source, target.key, record.operation.action, record.risk);
  return { source, resolved };
}
