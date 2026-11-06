import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), consume: vi.fn(), current: vi.fn(), active: vi.fn(), access: vi.fn() }));
vi.mock("../../src/http/export-auth.js", () => ({ requireExportAuth: mocks.authorize, EXPORT_SCOPES: { kioskCodeExchange: "auth-code:kiosk-exchange" } }));
vi.mock("../../src/auth/auth-code.js", () => ({ authCodeStore: { consume: mocks.consume } }));
vi.mock("../../src/auth/user-session-state.js", () => ({ assertUserSessionCurrent: mocks.current }));
vi.mock("../../src/federation/subject.js", () => ({ requireServiceAccess: mocks.active }));
vi.mock("../../src/auth/jwt.js", () => ({ generateAccessToken: mocks.access, ACCESS_TOKEN_SECONDS: 900 }));
const { handleAuthCodeExchange } = await import("../../src/http/auth-code-exchange-handler.js");
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue({ kind: "project", projectKey: "ostiarius" });
  mocks.consume.mockResolvedValue({ subject: { sub: "account", role: "general", authEpoch: 3 } });
  mocks.access.mockResolvedValue("access-1");
});
describe("kiosk code exchange", () => {
  it("requires the kiosk scope and consumes only a code for this kiosk project", async () => {
    const result = await handleAuthCodeExchange('{"code":"code"}', "Bearer project");
    expect(mocks.authorize).toHaveBeenCalledWith("Bearer project", "auth-code:kiosk-exchange");
    expect(mocks.consume).toHaveBeenCalledWith("code", { audience: "kiosk", projectKey: "ostiarius" });
    expect(result.data).toEqual({ userId: "account", accessToken: "access-1", expiresIn: 900 });
    expect(result.headers["Cache-Control"]).toBe("no-store");
    expect(result.data).not.toHaveProperty("refreshToken");
  });
  it("does not accept an administrator user token in place of the kiosk project", async () => {
    mocks.authorize.mockResolvedValue({ kind: "admin" });
    await expect(handleAuthCodeExchange('{"code":"code"}', "Bearer admin")).rejects.toMatchObject({ statusCode: 401 });
    expect(mocks.consume).not.toHaveBeenCalled();
  });
  it("rejects mismatched, expired and reused codes before issuing credentials", async () => {
    mocks.consume.mockResolvedValue(null);
    await expect(handleAuthCodeExchange('{"code":"code"}', "Bearer project")).rejects.toMatchObject({ statusCode: 401 });
    expect(mocks.access).not.toHaveBeenCalled();
  });
  it("checks revocation again at exchange", async () => {
    mocks.current.mockRejectedValue(new Error("revoked"));
    await expect(handleAuthCodeExchange('{"code":"code"}', "Bearer project")).rejects.toThrow("revoked");
    expect(mocks.access).not.toHaveBeenCalled();
  });
});
