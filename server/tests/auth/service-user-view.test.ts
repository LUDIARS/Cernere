import { describe, expect, it } from "vitest";
import { serviceUserView } from "../../src/auth/service-user-view.js";
describe("service identity disclosure", () => {
  const identity = { subject: "user", displayName: "User", email: "private@example.test", role: "general" };
  it("returns null email without an effective identity email grant", () => {
    expect(serviceUserView(identity, [{ key: "identity.basic", allowed: true }]).email).toBeNull();
    expect(serviceUserView(identity, [{ key: "identity_claim.email", allowed: false }]).email).toBeNull();
  });
  it("discloses only the allowed field while retaining null for absent email", () => {
    const permissions = [{ key: "identity_claim.email", allowed: true }];
    expect(serviceUserView(identity, permissions).email).toBe(identity.email);
    expect(serviceUserView({ ...identity, email: null }, permissions).email).toBeNull();
  });
});
