import { describe, expect, it } from "vitest";
import { isAllowedWhilePending } from "../../src/auth/pending-allowlist";
import { parseAccessStatus } from "../../src/auth/user-access";

const me = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";

describe("pending users get only self-service commands (registration approval A)", () => {
  it.each([
    ["profile", "set_display_name"],
    ["device_session", "list"],
    ["login_alert", "start"],
    ["security_event", "list"],
    ["user_access", "apply"],
    ["user_access", "status"],
  ])("allows %s.%s", (module, action) => {
    expect(isAllowedWhilePending(me, module, action, {})).toBe(true);
  });

  it.each([
    ["user", "search"],
    ["organization", "list"],
    ["member", "list"],
    ["managed_project", "my_data"],
    ["user_access", "decide"],
    ["unknown_module", "anything"],
  ])("denies %s.%s", (module, action) => {
    expect(isAllowedWhilePending(me, module, action, {})).toBe(false);
  });

  it("allows reading and deleting only their own account", () => {
    expect(isAllowedWhilePending(me, "user", "get", { userId: me })).toBe(true);
    expect(isAllowedWhilePending(me, "user", "get", { userId: other })).toBe(false);
    expect(isAllowedWhilePending(me, "user", "delete_account", {})).toBe(true);
    expect(isAllowedWhilePending(me, "user", "delete_account", { userId: other })).toBe(false);
  });
});

describe("parseAccessStatus", () => {
  it("keeps known states and treats anything else as locked (fail closed)", () => {
    expect(parseAccessStatus("pending")).toBe("pending");
    expect(parseAccessStatus("active")).toBe("active");
    expect(parseAccessStatus("locked")).toBe("locked");
    expect(parseAccessStatus(undefined)).toBe("locked");
    expect(parseAccessStatus("ACTIVE")).toBe("locked");
  });
});
