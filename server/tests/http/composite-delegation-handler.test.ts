import { beforeEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ source: vi.fn(), stored: vi.fn(), project: vi.fn(), target: vi.fn(), consent: vi.fn(), permissions: vi.fn(),
  set: vi.fn(), get: vi.fn(), getdel: vi.fn(), values: new Map<string, string>() }));
vi.mock("../../src/auth/composite-session.js", () => ({ currentCompositeSession: calls.source, currentStoredCompositeSession: calls.stored, currentCompositeProject: calls.project }));
vi.mock("../../src/db/connection.js", () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: calls.target }) }) }) } }));
vi.mock("../../src/consent/store.js", () => ({ getConsentRecord: calls.consent }));
vi.mock("../../src/project/user-permissions.js", () => ({ getProjectUserPermissions: calls.permissions }));
vi.mock("../../src/auth/composite-redirect.js", () => ({ registeredHubUrl: (definition: { hub_url: string }) => definition.hub_url }));
vi.mock("../../src/redis.js", () => ({ redis: { set: calls.set, get: calls.get, getdel: calls.getdel }, checkRateLimit: async () => {} }));
vi.mock("../../src/logging/auth-logger.js", () => ({ logAuthEvent: () => {} }));
const { handleCompositeDelegationRoute } = await import("../../src/http/composite-delegation-handler.js");
const operation = { action: "records.read", method: "GET", path: "/api/records/1", resource: "/api/records/1", contentDigest: "d".repeat(43), headersDigest: "h".repeat(43), requestId: "22222222-2222-4222-8222-222222222222" };
const request = { ...operation, projectToken: "source-scoped-token", sessionBinding: "s".repeat(43), targetProject: "aedilis", targetAudience: "https://aedilis.example" };
const permissions = [{ key: "identity.basic", allowed: true }, { key: "service_operation.records.read", allowed: true }];
const target = () => ({ key: "aedilis", isActive: true, credentialGeneration: 3, schemaDefinition: { hub_url: "https://aedilis.example",
  service_operations: [{ action: "records.read", risk: "sensitive_read", permissions: ["service_operation.records.read"] }] } });
const source = () => ({ project: { key: "glab", credentialGeneration: 2, schemaDefinition: { service_operations: [{ action: "delegate.aedilis.records.read", risk: "sensitive_read", permissions: ["service_operation.delegate.aedilis.records.read"] }] } },
  identity: { subject: "subject", role: "member", displayName: "Person", email: null },
  grant: { audience: "https://glab.example", source: { sub: "account" } }, grantId: "11111111-1111-4111-8111-111111111111",
  consent: { revoked: false, granted: ["service_operation.delegate.aedilis.records.read"] },
  permissions: [{ key: "service_operation.delegate.aedilis.records.read", allowed: true }], expiresAt: Date.now() + 600_000 });
beforeEach(() => {
  vi.resetAllMocks(); calls.values.clear();
  calls.source.mockResolvedValue(source()); calls.stored.mockResolvedValue(source()); calls.project.mockResolvedValue(target()); calls.target.mockResolvedValue([target()]);
  calls.permissions.mockResolvedValue({ permissions });
  calls.consent.mockResolvedValue({ revoked: false, decidedAt: "target-1", granted: ["identity.basic", "service_operation.records.read"] });
  calls.set.mockImplementation(async (key: string, value: string, ...options: unknown[]) => {
    if (options.includes("NX") && calls.values.has(key)) return null;
    calls.values.set(key, value); return "OK";
  });
  calls.get.mockImplementation(async (key: string) => calls.values.get(key) ?? null);
  calls.getdel.mockImplementation(async (key: string) => { const value = calls.values.get(key) ?? null; calls.values.delete(key); return value; });
});
async function issue(): Promise<string> {
  const result = await handleCompositeDelegationRoute("delegate", request, "Bearer source-project");
  return (result.data as { delegationToken: string }).delegationToken;
}
async function consume(token: string, changes: Record<string, unknown> = {}) {
  return handleCompositeDelegationRoute("consume-delegation", { ...operation, delegationToken: token, ...changes }, "Bearer destination-project");
}
describe("live downstream delegation", () => {
  it("binds issuance to the source and consumes only at the destination with current local-operation identity", async () => {
    const token = await issue();
    const result = await consume(token);
    expect(calls.source).toHaveBeenCalledWith(expect.objectContaining(request), "Bearer source-project");
    expect(calls.project).toHaveBeenCalledWith("Bearer destination-project");
    expect(calls.stored).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", request.sessionBinding);
    expect(result.data).toMatchObject({ allowed: true, projectKey: "aedilis", sourceProject: "glab", user: { id: "subject" } });
    expect(result.data).not.toHaveProperty("accessToken");
    expect(result.data).not.toHaveProperty("projectToken");
    await expect(consume(token)).rejects.toThrow();
  });
  it("never reissues the same request id", async () => { await issue(); await expect(issue()).rejects.toMatchObject({ statusCode: 409 }); });
  it.each(["method", "path", "resource", "contentDigest", "headersDigest", "requestId", "action"])("rejects a changed %s before execution", async field => {
    const token = await issue();
    const value = field === "method" ? "DELETE" : field.endsWith("Digest") ? "x".repeat(43) : field === "requestId" ? "33333333-3333-4333-8333-333333333333" : "changed";
    await expect(consume(token, { [field]: value })).rejects.toThrow();
  });
  it("rejects target credential rotation and another target project", async () => {
    const token = await issue();
    calls.project.mockResolvedValue({ ...target(), credentialGeneration: 4 });
    await expect(consume(token)).rejects.toThrow();
    calls.project.mockResolvedValue({ ...target(), key: "other" });
    await expect(consume(token)).rejects.toThrow();
  });
  it.each(["source", "stored", "consent", "permissions"] as const)("fails closed when %s state is unknown or unavailable", async stage => {
    if (stage === "source") { calls.source.mockRejectedValue(new Error("unavailable")); await expect(issue()).rejects.toThrow(); return; }
    const token = await issue();
    calls[stage].mockRejectedValue(new Error("unavailable"));
    await expect(consume(token)).rejects.toThrow("unavailable");
  });
  it("rejects source session revocation, generation changes, and identity changes", async () => {
    const token = await issue();
    calls.stored.mockRejectedValueOnce(new Error("session revoked"));
    await expect(consume(token)).rejects.toThrow();
    calls.stored.mockResolvedValue({ ...source(), project: { ...source().project, credentialGeneration: 5 } });
    await expect(consume(token)).rejects.toThrow();
    calls.stored.mockResolvedValue({ ...source(), identity: { ...source().identity, subject: "other" } });
    await expect(consume(token)).rejects.toThrow();
  });
  it("requires explicit current consent at both services and rejects a re-granted destination revision", async () => {
    calls.source.mockResolvedValueOnce({ ...source(), consent: null });
    await expect(issue()).rejects.toThrow();
    const token = await issue();
    calls.consent.mockResolvedValueOnce({ revoked: true, decidedAt: "target-1", granted: [] });
    await expect(consume(token)).rejects.toThrow();
    calls.consent.mockResolvedValue({ revoked: false, decidedAt: "target-2", granted: ["identity.basic", "service_operation.records.read"] });
    await expect(consume(token)).rejects.toThrow();
  });
  it("does not accept a caller-selected audience or an unclassified source operation", async () => {
    await expect(handleCompositeDelegationRoute("delegate", { ...request, targetAudience: "https://other.example" }, "source")).rejects.toThrow();
    calls.source.mockResolvedValue({ ...source(), project: { ...source().project, schemaDefinition: { service_operations: [] } } });
    await expect(issue()).rejects.toThrow();
  });
  it("allows only one concurrent consume", async () => {
    const token = await issue();
    const results = await Promise.allSettled([consume(token), consume(token)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });
});
