import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "../../../frontend/src/lib/api";

const mocks = vi.hoisted(() => ({ create: vi.fn(), proof: vi.fn() }));
vi.mock("../../../frontend/src/lib/webauthn", () => ({ startRegistration: mocks.create }));
vi.mock("../../../frontend/src/lib/action-auth", () => ({ authorizeAction: mocks.proof }));
vi.mock("../../../frontend/src/lib/browser-token-store", () => ({
  getAccessToken: () => "session", getRefreshToken: () => null, usesDeviceSession: () => false,
  setTokens: vi.fn(), clearTokens: vi.fn(),
}));
vi.mock("../../../frontend/src/lib/browser-refresh", () => ({ refreshBrowserAccessToken: vi.fn(), logoutDeviceSession: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("document", { cookie: "" });
  vi.stubGlobal("window", { location: { protocol: "https:" } });
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ id: "user" }) });
  mocks.proof.mockResolvedValue("proof");
  mocks.create.mockResolvedValue({ id: "credential" });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, status: 200,
    json: async () => url.endsWith("/list") ? { items: [{ id: "existing" }] }
      : url.endsWith("register-begin") ? { challenge: "challenge", authenticatorSelection: { userVerification: "required" } }
        : { ok: true, credentialId: "credential" },
  })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("embedded enrollment activation", () => {
  it("authorizes before preparation completes and calls create synchronously on the next click", async () => {
    const complete = await auth.preparePasskeyRegistration("device", { platformOnly: true });
    expect(mocks.proof).toHaveBeenCalledWith("passkey.register", "user");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("register-begin"), expect.objectContaining({
      headers: expect.objectContaining({ "X-Cernere-Action-Proof": "proof" }),
    }));
    const pending = complete();
    // Checked before any microtask: preparation/network must not consume this click.
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith({ optionsJSON: expect.objectContaining({
      authenticatorSelection: { userVerification: "required", authenticatorAttachment: "platform" },
    }) });
    await expect(pending).resolves.toEqual({ ok: true, credentialId: "credential" });
    expect(document.cookie).toContain("cernere_passkey_registered=1;");
    await expect(complete()).rejects.toThrow("期限切れ");
  });
  it("does not submit a cancelled credential and requires new preparation", async () => {
    mocks.create.mockRejectedValueOnce(new Error("cancelled"));
    const complete = await auth.preparePasskeyRegistration();
    await expect(complete()).rejects.toThrow("cancelled");
    expect(document.cookie).toBe("");
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("register-finish"))).toBe(false);
    await expect(complete()).rejects.toThrow("期限切れ");
  });
  it("rejects stale preparation before opening the authenticator", async () => {
    vi.useFakeTimers();
    const complete = await auth.preparePasskeyRegistration();
    vi.advanceTimersByTime(120_000);
    await expect(complete()).rejects.toThrow("期限切れ");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("does not mark registration when Cr rejects the created credential", async () => {
    const complete = await auth.preparePasskeyRegistration();
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: "rejected" }) } as Response);
    await expect(complete()).rejects.toThrow("rejected");
    expect(document.cookie).toBe("");
  });
});
