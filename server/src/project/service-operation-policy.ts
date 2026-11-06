import { z } from "zod";
import { AppError } from "../error.js";

/** @implements SPEC-COMPOSITE-OPERATION-GUARD */
export const serviceOperationPolicySchema = z.object({
  action: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{1,127}$/),
  risk: z.enum(["read", "sensitive_read", "important"]),
  permissions: z.array(z.string().min(1).max(200)).min(1).max(64),
}).strict().superRefine((policy, ctx) => {
  if (policy.risk !== "read" && policy.permissions.every(permission => permission === "identity.basic")) {
    ctx.addIssue({ code: "custom", message: "Protected operations require an explicit permission beyond identity.basic" });
  }
});
export const serviceOperationsSchema = z.array(serviceOperationPolicySchema).max(500).superRefine((policies, ctx) => {
  if (new Set(policies.map(policy => policy.action)).size !== policies.length) ctx.addIssue({ code: "custom", message: "Duplicate service operation action" });
});
export type ServiceOperationPolicy = z.infer<typeof serviceOperationPolicySchema>;

/** @implements SPEC-COMPOSITE-OPERATION-GUARD */
export function requireServiceOperationPolicy(definition: unknown, action: string): ServiceOperationPolicy {
  const value = definition && typeof definition === "object" ? (definition as { service_operations?: unknown }).service_operations : undefined;
  const parsed = serviceOperationsSchema.safeParse(value);
  const policy = parsed.success ? parsed.data.find(policy => policy.action === action) : undefined;
  if (!policy) throw AppError.forbidden("Service operation is not classified");
  return policy;
}
