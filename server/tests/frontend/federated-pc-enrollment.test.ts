import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { federationDevice } from "../../../frontend/src/lib/federation-api";

const mocks = vi.hoisted(() => ({ create: vi.fn(), tokens: vi.fn(), user: vi.fn(), marker: vi.fn() }));
vi.mock("../../../frontend/src/lib/webauthn", () => ({ startRegistration: mocks.create }));
vi.mock("../../../frontend/src/lib/action-auth", () => ({ authorizeAction: vi.fn() }));
vi.mock("../../../frontend/src/lib/browser-token-store", () => ({ getAccessToken: () => "phone-session", setTokens: mocks.tokens }));
vi.mock("../../../frontend/src/lib/api", () => ({ setStoredUser: mocks.user }));
vi.mock("../../../frontend/src/lib/login-cookie", () => ({ rememberRegisteredPasskeyCookie: mocks.marker }));
const ticket = { requestId: "request", deviceSecret: "device-secret" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ id: "pc-key" });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () =>
    url.endsWith("signup-begin") ? { signupId: "signup", options: { challenge: "challenge", authenticatorSelection: { userVerification: "required" } } }
      : { user: { id: "pc-user", displayName: "User", role: "general" }, accessToken: "pc-session", refreshToken: "refresh" },
  })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("does not confuse the phone session with the new PC identity", async () => {
  await federationDevice.createRequest(true);
  await federationDevice.claimInvite("invite", true);
  for (const [, options] of vi.mocked(fetch).mock.calls) expect(options?.headers).not.toHaveProperty("Authorization");
  await federationDevice.createRequest();
  expect(vi.mocked(fetch).mock.lastCall?.[1]?.headers).toHaveProperty("Authorization", "Bearer phone-session");
});
it("registers a local PC credential on a fresh click and stores the PC session only after federation finishes", async () => {
  const complete = await federationDevice.prepareNewDevice(ticket, true);
  expect(mocks.create).not.toHaveBeenCalled();
  const pending = complete();
  expect(mocks.create).toHaveBeenCalledWith({ optionsJSON: expect.objectContaining({ authenticatorSelection: { userVerification: "required", authenticatorAttachment: "platform" } }) });
  expect(mocks.tokens).not.toHaveBeenCalled();
  await pending;
  const finish = vi.mocked(fetch).mock.lastCall!;
  expect(JSON.parse(String(finish[1]?.body))).toMatchObject({ federation: ticket, response: { id: "pc-key" } });
  expect(mocks.tokens).toHaveBeenCalledWith("pc-session", "refresh");
  expect(mocks.marker).toHaveBeenCalledOnce();
  await expect(complete()).rejects.toThrow("期限切れ");
  expect(mocks.create).toHaveBeenCalledOnce();
});
it("does not replace the phone session or mark registration when completion fails", async () => {
  const complete = await federationDevice.prepareNewDevice(ticket, true);
  vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: "already completed" }) } as Response);
  await expect(complete()).rejects.toThrow("already completed");
  expect(mocks.tokens).not.toHaveBeenCalled();
  expect(mocks.marker).not.toHaveBeenCalled();
});
