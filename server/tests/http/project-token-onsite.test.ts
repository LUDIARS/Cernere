import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gate: vi.fn(), policy: vi.fn(), sign: vi.fn(), select: vi.fn(), access: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("../../src/db/connection.js", () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ limit: mocks.select }) }) }),
} }));
vi.mock("../../src/auth/jwt.js", () => ({
  verifyToken: mocks.verify, extractBearerToken: () => "bearer", REFRESH_TOKEN_DAYS: 30,
}));
vi.mock("../../src/auth/paseto.js", () => ({ isPasetoEnabled: () => true, signProjectToken: mocks.sign }));
vi.mock("../../src/redis.js", () => ({ checkRateLimit: vi.fn(), redis: {} }));
vi.mock("../../src/logging/auth-logger.js", () => ({}));
vi.mock("../../src/logging/dev-logger.js", () => ({ devLog: vi.fn() }));
vi.mock("../../src/auth/auth-code.js", () => ({}));
vi.mock("../../src/consent/gate.js", () => ({}));
vi.mock("../../src/federation/subject.js", () => ({
  requireServiceAccess: mocks.access,
  loadServiceIdentity: async () => ({ primaryUserId: "primary", subject: "federated" }),
}));
vi.mock("../../src/notify/alert-targets.js", () => ({}));
vi.mock("../../src/auth/action-proof.js", () => ({}));
vi.mock("../../src/http/oauth-handler.js", () => ({}));
vi.mock("../../src/project/onsite-mfa-policy.js", () => ({ projectOnsiteRequirement: mocks.policy }));
vi.mock("../../src/auth/project-token-onsite.js", () => ({ authorizeProjectTokenOnsite: mocks.gate }));

const { handleAuthRoute } = await import("../../src/http/auth-handler.js");
const requirement = { minAssurance: "high", allowedPlaceIds: ["place-1"] };
const body = JSON.stringify({ project_key: "Schedula", hub_url: "https://service.example", mfaToken: "proof" });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.verify.mockResolvedValue({ sub: "account", authentication: { amr: ["pop", "mfa"] } });
  mocks.select.mockResolvedValueOnce([{ key: "Schedula", isActive: true }])
    .mockResolvedValueOnce([{ id: "primary", role: "general", displayName: "User" }]);
  mocks.policy.mockResolvedValue(requirement);
  mocks.gate.mockResolvedValue(null);
  mocks.sign.mockResolvedValue("signed-token");
});

describe("project-token onsite gate", () => {
  it("uses current project policy and actual authenticated account before signing", async () => {
    const result = await handleAuthRoute("project-token", body, "Bearer bearer");
    expect(mocks.policy).toHaveBeenCalledWith("Schedula");
    expect(mocks.gate).toHaveBeenCalledWith({ userId: "account", bearerToken: "bearer",
      projectKey: "Schedula", requirement, mfaToken: "proof" });
    expect(mocks.gate.mock.invocationCallOrder[0]).toBeLessThan(mocks.sign.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({ status: "200 OK", data: { accessToken: "signed-token", userId: "federated" } });
  });

  it("returns only a challenge when onsite proof is missing, even with passkey MFA claims", async () => {
    mocks.gate.mockResolvedValue({ mfaRequired: true, mfaToken: "mfa_ticket", mfaMethods: ["onsite"] });
    const result = await handleAuthRoute("project-token", body, "Bearer bearer");
    expect(result).toMatchObject({ status: "403 Forbidden", data: { error: "onsite_mfa_required", mfaRequired: true } });
    expect(result.data).not.toHaveProperty("accessToken");
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("does not sign when proof verification fails", async () => {
    mocks.gate.mockRejectedValue(new Error("invalid proof"));
    await expect(handleAuthRoute("project-token", body, "Bearer bearer")).rejects.toThrow("invalid proof");
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("fails closed when onsite policy is malformed", async () => {
    mocks.policy.mockRejectedValue(new Error("misconfigured"));
    await expect(handleAuthRoute("project-token", body, "Bearer bearer")).rejects.toThrow("misconfigured");
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });
});
