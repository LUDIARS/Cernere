import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ credential: vi.fn(), projectCurrent: vi.fn(), project: vi.fn(), paseto: vi.fn(), grant: vi.fn(),
  userCurrent: vi.fn(), access: vi.fn(), identity: vi.fn(), consent: vi.fn(), permissions: vi.fn(), bound: vi.fn() }));
vi.mock("../../src/auth/jwt.js", () => ({ extractBearerToken: () => "credential", verifyProjectToken: mocks.credential }));
vi.mock("../../src/db/connection.js", () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.project }) }) }) } }));
vi.mock("../../src/auth/paseto.js", () => ({ verifyProjectTokenPaseto: mocks.paseto }));
vi.mock("../../src/auth/composite-grant.js", () => ({ readCompositeGrant: mocks.grant, COMPOSITE_GRANT_TTL_SECONDS: 900 }));
vi.mock("../../src/auth/composite-session-store.js", () => ({ CompositeSessionStore: class { requireBound = mocks.bound; } }));
vi.mock("../../src/auth/composite-redirect.js", () => ({ registeredHubUrl: () => "https://glab.example" }));
vi.mock("../../src/auth/user-session-state.js", () => ({ assertUserSessionCurrent: mocks.userCurrent }));
vi.mock("../../src/project/project-credential-state.js", () => ({ isCurrentProjectCredential: mocks.projectCurrent }));
vi.mock("../../src/federation/subject.js", () => ({ requireServiceAccess: mocks.access, loadServiceIdentity: mocks.identity }));
vi.mock("../../src/consent/store.js", () => ({ getConsentRecord: mocks.consent }));
vi.mock("../../src/project/user-permissions.js", () => ({ getProjectUserPermissions: mocks.permissions }));
vi.mock("../../src/redis.js", () => ({ redis: {} }));
const { currentCompositeSession } = await import("../../src/auth/composite-session.js");
const input = { projectToken: "paseto", sessionBinding: "s".repeat(43) };
const source = { sub: "account", role: "general", authEpoch: 3 };
const grant = () => ({ version: 1, projectKey: "glab", audience: "https://glab.example", subjectId: "user", role: "general",
  source, issuedAt: Date.now(), consentRevision: "decision-1" });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.credential.mockReturnValue({ sub: "client", projectKey: "glab", credentialGeneration: 4 });
  mocks.projectCurrent.mockResolvedValue(true); mocks.project.mockResolvedValue([{ key: "glab", clientId: "client", credentialGeneration: 4, isActive: true }]);
  mocks.paseto.mockResolvedValue({ kind: "user_for_project", projectKey: "glab", sub: "user", role: "general", compositeGrant: { version: 1, id: "grant" }, exp: new Date(Date.now() + 600_000).toISOString() });
  mocks.grant.mockResolvedValue(grant()); mocks.identity.mockResolvedValue({ subject: "user", role: "general" });
  mocks.consent.mockResolvedValue({ revoked: false, decidedAt: "decision-1" });
  mocks.permissions.mockResolvedValue({ permissions: [{ key: "identity.basic", allowed: true }] });
});
describe("live composite session authority", () => {
  it("checks the signed project token, fixed session binding and original user's current state", async () => {
    await currentCompositeSession(input, "Bearer credential");
    expect(mocks.projectCurrent).toHaveBeenCalledWith("client", "glab", 4);
    expect(mocks.paseto).toHaveBeenCalledWith("paseto", "https://glab.example");
    expect(mocks.bound).toHaveBeenCalledWith("grant", input.sessionBinding);
    expect(mocks.userCurrent).toHaveBeenCalledWith(source);
  });
  it.each(["projectCurrent", "bound", "userCurrent", "access", "consent", "permissions"] as const)("does not cache an old positive decision when %s fails", async key => {
    await currentCompositeSession(input, "Bearer credential");
    mocks[key].mockRejectedValue(new Error("unavailable"));
    await expect(currentCompositeSession(input, "Bearer credential")).rejects.toThrow("unavailable");
  });
  it("rejects identity and consent revision changes", async () => {
    mocks.identity.mockResolvedValue({ subject: "another", role: "general" });
    await expect(currentCompositeSession(input, "Bearer credential")).rejects.toMatchObject({ statusCode: 401 });
    mocks.identity.mockResolvedValue({ subject: "user", role: "general" });
    mocks.consent.mockResolvedValue({ revoked: false, decidedAt: "decision-2" });
    await expect(currentCompositeSession(input, "Bearer credential")).rejects.toMatchObject({ statusCode: 401 });
  });
  it("rejects a project credential rotated between the live credential and project reads", async () => {
    mocks.project.mockResolvedValue([{ key: "glab", clientId: "client", credentialGeneration: 5, isActive: true }]);
    await expect(currentCompositeSession(input, "Bearer credential")).rejects.toMatchObject({ statusCode: 401 });
    expect(mocks.paseto).not.toHaveBeenCalled();
  });
  it("rejects an unversioned or another project's grant", async () => {
    mocks.grant.mockResolvedValue({ ...grant(), projectKey: "other" });
    await expect(currentCompositeSession(input, "Bearer credential")).rejects.toMatchObject({ statusCode: 401 });
    mocks.grant.mockResolvedValue(null);
    await expect(currentCompositeSession(input, "Bearer credential")).rejects.toMatchObject({ statusCode: 401 });
  });
  it("allows initial binding validation without treating the session as already bound", async () => {
    await currentCompositeSession(input, "Bearer credential", false);
    expect(mocks.bound).not.toHaveBeenCalled(); expect(mocks.userCurrent).toHaveBeenCalledOnce();
  });
});
