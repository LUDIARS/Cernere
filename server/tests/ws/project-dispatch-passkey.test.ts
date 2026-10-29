import { describe, expect, it, vi, beforeEach } from "vitest";

const mockExecute = vi.fn();
vi.mock("../../src/http/passkey-handler.js", () => ({
  executePasskeyCompositeAction: (...args: unknown[]) => mockExecute(...args),
  isPasskeyCompositeAction: (action: string) => [
    "passkey-login-begin",
    "passkey-login-finish",
    "passkey-signup-begin",
    "passkey-signup-finish",
  ].includes(action),
}));

const { dispatchProjectCommand } = await import("../../src/ws/project-dispatch.js");

describe("dispatchProjectCommand — auth.passkey-* (embedded SDK ceremony relay)", () => {
  beforeEach(() => {
    mockExecute.mockReset().mockResolvedValue({ ok: true });
  });

  it.each([
    "passkey-login-begin",
    "passkey-login-finish",
    "passkey-signup-begin",
    "passkey-signup-finish",
  ])("routes auth.%s to the passkey handler with the bound projectKey", async (action) => {
    const result = await dispatchProjectCommand("schedula", "auth", action, { name: "alice" });
    expect(mockExecute).toHaveBeenCalledWith(action, { name: "alice" }, {
      projectKey: "schedula",
    });
    expect(result).toEqual({ ok: true });
  });

  it("strips a service-supplied clientIp from the ceremony and only uses it as a per-client hint", async () => {
    await dispatchProjectCommand("schedula", "auth", "passkey-signup-begin", {
      name: "alice",
      clientIp: "2001:db8:1:2::7",
    });
    // ヒントは project の枠の中を利用者ごとに分けるだけ (projectKey は常に WS の認証から)。
    expect(mockExecute).toHaveBeenCalledWith(
      "passkey-signup-begin",
      { name: "alice" },
      { projectKey: "schedula", clientHint: "2001:db8:1:2::/64" },
    );
  });

  it("drops a clientIp that is not an IP address", async () => {
    await dispatchProjectCommand("schedula", "auth", "passkey-login-begin", { clientIp: "evil, 1.2.3.4" });
    expect(mockExecute).toHaveBeenCalledWith("passkey-login-begin", {}, { projectKey: "schedula" });
  });

  it("ignores an empty / non-string clientIp", async () => {
    await dispatchProjectCommand("schedula", "auth", "passkey-login-begin", { clientIp: 42 });
    expect(mockExecute).toHaveBeenCalledWith(
      "passkey-login-begin",
      {},
      { projectKey: "schedula" },
    );
  });

  it("propagates handler failures (expired challenge etc.) to the WS caller", async () => {
    mockExecute.mockRejectedValue(new Error("Challenge expired or missing - please retry"));
    await expect(
      dispatchProjectCommand("schedula", "auth", "passkey-login-finish", { challengeOwner: "x" }),
    ).rejects.toThrow(/Challenge expired/);
  });
});
