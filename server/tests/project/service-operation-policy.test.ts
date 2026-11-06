import { describe, expect, it } from "vitest";
import { requireServiceOperationPolicy, serviceOperationsSchema } from "../../src/project/service-operation-policy.js";

describe("declared service operation authority", () => {
  it("denies missing and unknown classifications", () => {
    expect(() => requireServiceOperationPolicy({}, "profile.read")).toThrow("not classified");
    expect(() => requireServiceOperationPolicy({ service_operations: [] }, "profile.read")).toThrow("not classified");
  });
  it("requires explicit permissions for sensitive GETs and important operations", () => {
    for (const risk of ["sensitive_read", "important"]) {
      expect(serviceOperationsSchema.safeParse([{ action: "profile.read", risk, permissions: ["identity.basic"] }]).success).toBe(false);
      expect(serviceOperationsSchema.safeParse([{ action: "profile.read", risk, permissions: ["profile.email"] }]).success).toBe(true);
    }
  });
  it("rejects duplicate actions and unknown risk classifications", () => {
    const policy = { action: "profile.read", risk: "read", permissions: ["identity.basic"] };
    expect(serviceOperationsSchema.safeParse([policy, policy]).success).toBe(false);
    expect(serviceOperationsSchema.safeParse([{ ...policy, risk: "safe_get" }]).success).toBe(false);
  });
});
