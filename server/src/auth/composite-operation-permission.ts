/** Current operation permissions and consent, shared by direct and delegated calls.
 * @implements SPEC-COMPOSITE-OPERATION-GUARD
 */
import { AppError } from "../error.js";
import { requireServiceOperationPolicy, type ServiceOperationPolicy } from "../project/service-operation-policy.js";
import type { CompositeSessionContext } from "./composite-session.js";

export function requireCompositeOperation(context: Pick<CompositeSessionContext, "project" | "permissions" | "consent">,
  action: string, explicitConsent = false): ServiceOperationPolicy {
  const policy = requireServiceOperationPolicy(context.project.schemaDefinition, action);
  const allowed = new Set(context.permissions.filter(permission => permission.allowed).map(permission => permission.key));
  if (policy.permissions.some(permission => !allowed.has(permission))) throw AppError.forbidden("Service operation permission is not granted");
  if ((explicitConsent || policy.risk !== "read") && (!context.consent || context.consent.revoked
    || policy.permissions.some(permission => !context.consent?.granted.includes(permission)))) {
    throw AppError.forbidden("Explicit consent is required for this service operation");
  }
  return policy;
}
