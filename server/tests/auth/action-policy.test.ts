import { describe, expect, it } from "vitest";

import { protectedActionSchema, resolveWsActionTarget } from "../../src/auth/action-policy.js";

describe("resolveWsActionTarget", () => {
  it.each(["oauth.link", "oauth.unlink"])("registers %s for HTTP step-up", (action) => {
    expect(protectedActionSchema.safeParse(action).success).toBe(true);
  });

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

  // spec/feature/edge-assertion-login.md §11:
  // binding の変更は「どのアサーションを受理するか」を書き換えるので step-up 対象。
  it.each(["register", "update", "enable", "disable"])(
    "requires step-up for edge_idp.%s and binds it to the project",
    (action) => {
      expect(resolveWsActionTarget("admin-1", "edge_idp", action, { projectKey: "corp-hub" })).toEqual({
        action: `edge_idp.${action}`,
        resource: "corp-hub",
      });
    },
  );

  it("requires step-up for edge_idp.purge_user and binds it to the target user", () => {
    expect(resolveWsActionTarget("admin-1", "edge_idp", "purge_user", {
      userId: "user-9",
      confirmEmail: "taro@example.co.jp",
    })).toEqual({
      action: "edge_idp.purge_user",
      resource: "user-9",
    });
  });

  it("does not step up read-only edge_idp actions", () => {
    expect(resolveWsActionTarget("admin-1", "edge_idp", "list", {})).toBeNull();
    expect(resolveWsActionTarget("admin-1", "edge_idp", "stale_identities", { days: 90 })).toBeNull();
  });
});
