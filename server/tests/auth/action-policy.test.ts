import { describe, expect, it } from "vitest";

import { resolveWsActionTarget } from "../../src/auth/action-policy.js";

describe("resolveWsActionTarget", () => {
  it("binds a member role change to both organization and target user", () => {
    expect(resolveWsActionTarget("actor", "member", "update_role", {
      organizationId: "org-1",
      userId: "user-2",
      role: "admin",
    })).toEqual({
      action: "member.update_role",
      resource: "org-1:user-2",
    });
  });

  it("binds self account deletion to the authenticated user", () => {
    expect(resolveWsActionTarget("user-1", "user", "delete_account", {})).toEqual({
      action: "user.delete_account",
      resource: "user-1",
    });
  });

  it("does not step up routine profile updates", () => {
    expect(resolveWsActionTarget("user-1", "profile", "update", { bio: "hello" })).toBeNull();
  });
});
