import { describe, expect, it } from "vitest";
import { capsFromProjectDefinition, isWithinCaps, parsePermissionKey } from "../../src/consent/permission-keys.js";
import { validateConsentDeclaration } from "../../src/consent/declaration.js";
const permission = { key: "service_operation.attendance.read", level: "recommended" as const, purpose: "自分の出席記録を見る", visible_to: ["self" as const] };
describe("consent for data owned by a service", () => {
  it("uses only administrator-registered operation caps", () => {
    const caps = capsFromProjectDefinition({ service_operations: [{ action: "attendance.read", risk: "sensitive_read", permissions: [permission.key] }] });
    expect(caps.serviceOperations).toEqual(["attendance.read"]);
    expect(isWithinCaps(parsePermissionKey(permission.key)!, caps)).toBe(true);
    expect(caps.userDataModules).toEqual([]);
    expect(validateConsentDeclaration({ version: 1, permissions: [permission] }, caps, null, null).ok).toBe(true);
  });
  it("cannot self-declare an operation grant outside the administrator cap", () => {
    const caps = capsFromProjectDefinition({ consent: { version: 1, permissions: [permission] } });
    expect(validateConsentDeclaration({ version: 1, permissions: [permission] }, caps, null, null).ok).toBe(false);
  });
  it("rejects malformed operation policies instead of deriving partial grants", () => {
    const caps = capsFromProjectDefinition({ service_operations: [{ action: "attendance.read", risk: "unknown", permissions: [permission.key] }] });
    expect(caps.serviceOperations).toEqual([]);
  });
});
