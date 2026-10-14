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
