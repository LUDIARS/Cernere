import { describe, expect, it } from "vitest";
import { resolveWsActionTarget } from "../../src/auth/action-policy";

const user = "6f0c9a8e-1111-4222-8333-944445555666";

describe("login_alert action proofs", () => {
  it.each(["start", "remove"])("requires login_alert.manage bound to the channel for %s", (action) => {
    expect(resolveWsActionTarget(user, "login_alert", action, { channel: "discord" }))
      .toEqual({ action: "login_alert.manage", resource: "discord" });
  });

  it.each(["list", "verify"])("does not require a proof for %s", (action) => {
    expect(resolveWsActionTarget(user, "login_alert", action, { channel: "google", code: "000000" })).toBeNull();
  });
});

describe("enterprise identity suggestions", () => {
  it("requires the same proof as saving an identity, bound to project and user", () => {
    expect(resolveWsActionTarget(user, "enterprise", "accept_suggestion", {
      projectKey: "concordia", userId: "7a0c9a8e-1111-4222-8333-944445555666", subjectHash: "a".repeat(64),
    })).toEqual({ action: "enterprise.save_identity", resource: "concordia:7a0c9a8e-1111-4222-8333-944445555666" });
  });
});
