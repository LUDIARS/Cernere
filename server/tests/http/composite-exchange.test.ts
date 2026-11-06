import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  projectCurrent: vi.fn(), consume: vi.fn(), target: vi.fn(), userCurrent: vi.fn(), active: vi.fn(),
  identity: vi.fn(), consent: vi.fn(), sign: vi.fn(), grant: vi.fn(), refreshInsert: vi.fn(), pair: vi.fn(),
}));
vi.mock("../../src/auth/jwt.js", () => ({
  extractBearerToken: (value: string) => value.replace(/^Bearer /, ""),
  verifyProjectToken: (value: string) => {
    if (value !== "project-token") throw new Error("invalid token");
    return { sub: "client-glab", projectKey: "glab", credentialGeneration: 4 };
  },
  generateTokenPair: mocks.pair, REFRESH_TOKEN_DAYS: 30,
}));
vi.mock("../../src/auth/auth-code.js", () => ({ authCodeStore: { consume: mocks.consume } }));
vi.mock("../../src/auth/token-hash.js", () => ({ hashRefreshToken: (value: string) => `hash:${value}` }));
vi.mock("../../src/auth/user-session-state.js", () => ({ assertUserSessionCurrent: mocks.userCurrent }));
vi.mock("../../src/auth/paseto.js", () => ({ signProjectToken: mocks.sign }));
vi.mock("../../src/auth/composite-redirect.js", () => ({ projectCompositeTarget: mocks.target, registeredHubUrl: () => "https://glab.example" }));
vi.mock("../../src/project/project-credential-state.js", () => ({ isCurrentProjectCredential: mocks.projectCurrent }));
vi.mock("../../src/federation/subject.js", () => ({ requireServiceAccess: mocks.active, loadServiceIdentity: mocks.identity }));
vi.mock("../../src/consent/gate.js", () => ({ enforceServiceConsent: mocks.consent }));
vi.mock("../../src/consent/store.js", () => ({ getConsentRecord: async () => null }));
vi.mock("../../src/project/user-permissions.js", () => ({ getProjectUserPermissions: async () => ({ permissions: [] }) }));
vi.mock("../../src/http/cernere-origin.js", () => ({ isCernereFrontendOrigin: (value: string) => value === "https://cr.example" }));
vi.mock("../../src/auth/composite-grant.js", () => ({ createCompositeGrant: mocks.grant, COMPOSITE_GRANT_TTL_SECONDS: 900 }));
vi.mock("../../src/db/connection.js", () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "account", role: "general", displayName: "Person", email: null }] }) }) }),
  insert: () => ({ values: mocks.refreshInsert }),
} }));
const { exchangeServiceCode, exchangeSelfCode } = await import("../../src/http/composite-exchange.js");
const source = { sub: "account", role: "general", authEpoch: 5 };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.projectCurrent.mockResolvedValue(true);
  mocks.consume.mockResolvedValue({ binding: { audience: "service", projectKey: "glab", origin: "https://glab.example" }, subject: source });
  mocks.target.mockResolvedValue({ key: "glab", schemaDefinition: {} });
  mocks.identity.mockResolvedValue({ subject: "federated-id", displayName: "Person", email: null, role: "general" });
  mocks.sign.mockResolvedValue("paseto-project-token");
  mocks.grant.mockResolvedValue("grant-id");
  mocks.pair.mockResolvedValue({ accessToken: "self-access", refreshToken: "self-refresh", authEpoch: 5 });
});

describe("service authorization code exchange boundary", () => {
  it("authenticates the project, uses its PKCE expectation and returns only its token", async () => {
    const result = await exchangeServiceCode({ code: "code", code_verifier: "verifier" }, "Bearer project-token");
    expect(mocks.projectCurrent).toHaveBeenCalledWith("client-glab", "glab", 4);
    expect(mocks.consume).toHaveBeenCalledWith("code", { audience: "service", projectKey: "glab", codeVerifier: "verifier" });
    expect(mocks.target).toHaveBeenCalledWith("client-glab", "https://glab.example");
    expect(mocks.userCurrent).toHaveBeenCalledWith(source);
    expect(mocks.grant).toHaveBeenCalledWith(expect.objectContaining({ source, subjectId: "federated-id", projectKey: "glab" }));
    expect(mocks.sign).toHaveBeenCalledWith(expect.objectContaining({ audience: "https://glab.example", ttlSec: 900, compositeGrant: { version: 1, id: "grant-id" } }));
    expect(result.data).toEqual({ projectToken: "paseto-project-token", user: { id: "federated-id", displayName: "Person", email: null, role: "general" } });
    expect(mocks.pair).not.toHaveBeenCalled();
    expect(mocks.refreshInsert).not.toHaveBeenCalled();
  });
  it("rejects an absent or nonproject bearer before consuming the code", async () => {
    await expect(exchangeServiceCode({ code: "code" }, "Bearer user-token")).rejects.toMatchObject({ statusCode: 401 });
    expect(mocks.consume).not.toHaveBeenCalled();
  });
  it("rejects rotated project credentials before consuming the code", async () => {
    mocks.projectCurrent.mockResolvedValue(false);
    await expect(exchangeServiceCode({ code: "code" }, "Bearer project-token")).rejects.toMatchObject({ statusCode: 401 });
    expect(mocks.consume).not.toHaveBeenCalled();
  });
  it.each(["target", "userCurrent", "active", "consent", "grant"] as const)("issues nothing when %s is unavailable or denies access", async key => {
    mocks[key].mockRejectedValue(new Error("denied or unavailable"));
    await expect(exchangeServiceCode({ code: "code", code_verifier: "verifier" }, "Bearer project-token")).rejects.toThrow();
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it("rejects wrong-purpose or reused codes without minting a token", async () => {
    mocks.consume.mockResolvedValue(null);
    await expect(exchangeServiceCode({ code: "code" }, "Bearer project-token")).rejects.toMatchObject({ statusCode: 401 });
    expect(mocks.sign).not.toHaveBeenCalled();
  });
});

describe("self exchange boundary", () => {
  it("requires the Cernere frontend origin before consuming any code", async () => {
    await expect(exchangeSelfCode({ code: "code" }, "https://glab.example")).rejects.toMatchObject({ statusCode: 401 });
    expect(mocks.consume).not.toHaveBeenCalled();
  });
  it("owns the only access/refresh session creation path", async () => {
    await exchangeSelfCode({ code: "code", code_verifier: "verifier" }, "https://cr.example");
    expect(mocks.consume).toHaveBeenCalledWith("code", { audience: "cernere", origin: "https://cr.example", codeVerifier: "verifier" });
    expect(mocks.refreshInsert).toHaveBeenCalledOnce();
    expect(mocks.sign).not.toHaveBeenCalled();
  });
});
