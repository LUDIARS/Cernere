import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ source: vi.fn(), stored: vi.fn(), project: vi.fn(), target: vi.fn(), permissions: vi.fn(), consent: vi.fn(),
  set: vi.fn(), get: vi.fn(), getdel: vi.fn(), values: new Map<string, string>() }));
vi.mock("../../src/auth/composite-session.js", () => ({ currentCompositeSession: calls.source, currentStoredCompositeSession: calls.stored,
  currentCompositeProject: calls.project, compositeSessionStore: {} }));
vi.mock("../../src/db/connection.js", () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: calls.target }) }) }) } }));
vi.mock("../../src/consent/store.js", () => ({ getConsentRecord: calls.consent }));
vi.mock("../../src/project/user-permissions.js", () => ({ getProjectUserPermissions: calls.permissions }));
vi.mock("../../src/auth/composite-redirect.js", () => ({ registeredHubUrl: (definition: { hub_url: string }) => definition.hub_url }));
vi.mock("../../src/redis.js", () => ({ redis: { set: calls.set, get: calls.get, getdel: calls.getdel }, checkRateLimit: async () => {} }));
vi.mock("../../src/logging/auth-logger.js", () => ({ logAuthEvent: () => {} }));
const { handleCompositeServiceRoute } = await import("../../src/http/composite-service-handler.js");
const operation = { action: "media.write", method: "PUT", path: "/api/media/1", resource: "/api/media/1", contentDigest: "d".repeat(43),
  headersDigest: "h".repeat(43), requestId: "22222222-2222-4222-8222-222222222222" };
const requestBinding = "r".repeat(43), limits = { maximumBytes: 200 * 1024 * 1024, timeoutSeconds: 300 };
const source = () => ({ project: { key: "glab", credentialGeneration: 2, schemaDefinition: { service_operations: [
  { action: "delegate.volputas.media.write", risk: "important", permissions: ["service_operation.delegate.volputas.media.write"] }] } },
  identity: { subject: "subject", role: "general", displayName: "Person", email: null },
  grant: { audience: "https://glab.example", source: { sub: "account" } }, grantId: "11111111-1111-4111-8111-111111111111",
  consent: { revoked: false, granted: ["service_operation.delegate.volputas.media.write"] },
  permissions: [{ key: "service_operation.delegate.volputas.media.write", allowed: true }], expiresAt: Date.now() + 600_000 });
const target = () => ({ key: "volputas", isActive: true, credentialGeneration: 3, schemaDefinition: { hub_url: "https://vo.example",
  service_operations: [{ action: "media.write", risk: "important", permissions: ["service_operation.media.write"], upload: { ...limits } }] } });
async function route(action: string, body: unknown) { return handleCompositeServiceRoute(action, JSON.stringify(body), "Bearer current-project"); }
async function issue() {
  const result = await route("delegate-upload", { ...operation, byteLength: 64, projectToken: "scoped", sessionBinding: "s".repeat(43), targetProject: "volputas", targetAudience: "https://vo.example" });
  return (result.data as { arrivalToken: string }).arrivalToken;
}
async function begin(arrivalToken: string, changed: Record<string, unknown> = {}) {
  const { contentDigest: _digest, ...metadata } = operation;
  const result = await route("begin-upload", { ...metadata, arrivalToken, requestBinding, limits, risk: "important", ...changed });
  return result.data as { receipt: string; expiresAt: string };
}
async function finish(receipt: string, changed: Record<string, unknown> = {}) {
  return route("finalize-upload", { ...operation, receipt, requestBinding, byteLength: 64, risk: "important", ...changed });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-06T05:00:00Z"));
  vi.resetAllMocks(); calls.values.clear();
  calls.source.mockResolvedValue(source()); calls.stored.mockResolvedValue(source()); calls.project.mockResolvedValue(target()); calls.target.mockResolvedValue([target()]);
  calls.permissions.mockResolvedValue({ permissions: [{ key: "identity.basic", allowed: true }, { key: "service_operation.media.write", allowed: true }] });
  calls.consent.mockResolvedValue({ revoked: false, decidedAt: "target-1", granted: ["identity.basic", "service_operation.media.write"] });
  calls.set.mockImplementation(async (key: string, value: string, ...options: unknown[]) => {
    if (options.includes("NX") && calls.values.has(key)) return null;
    calls.values.set(key, value); return "OK";
  });
  calls.get.mockImplementation(async (key: string) => calls.values.get(key) ?? null);
  calls.getdel.mockImplementation(async (key: string) => { const raw = calls.values.get(key) ?? null; calls.values.delete(key); return raw; });
});
afterEach(() => vi.useRealTimers());

describe("project-authenticated bounded upload HTTP", () => {
  it("reserves at arrival and rechecks authority after a transfer crossing the capability lifetime", async () => {
    const token = await issue(), reservation = await begin(token);
    vi.setSystemTime(Date.now() + 40_000);
    const result = (await finish(reservation.receipt)).data as { allowed: boolean; user: { id: string }; expiresAt: string };
    expect(result).toMatchObject({ allowed: true, user: { id: "subject" }, expiresAt: reservation.expiresAt });
    expect(calls.stored).toHaveBeenCalledTimes(2);
    await expect(finish(reservation.receipt)).rejects.toThrow();
  });
  it.each([{ action: "media.other" }, { method: "POST" }, { path: "/api/media/2", resource: "/api/media/2" }, { headersDigest: "x".repeat(43) },
    { requestId: "33333333-3333-4333-8333-333333333333" }, { risk: "read" }])("refuses another arrival envelope: %j", async changed => {
    await expect(begin(await issue(), changed)).rejects.toThrow();
  });
  it.each([{ contentDigest: "x".repeat(43) }, { byteLength: 63 }, { requestBinding: "x".repeat(43) }])("burns a changed completion without a second execution: %j", async changed => {
    const reservation = await begin(await issue());
    await expect(finish(reservation.receipt, changed)).rejects.toThrow();
    await expect(finish(reservation.receipt)).rejects.toThrow();
  });
  it("cannot redeem an upload arrival at the ordinary delegation endpoint", async () => {
    const arrivalToken = await issue();
    await expect(route("consume-delegation", { ...operation, delegationToken: arrivalToken })).rejects.toThrow();
  });
  it("refuses a revoked source after receipt consumption and never retries that receipt", async () => {
    const reservation = await begin(await issue()); calls.stored.mockRejectedValue(new Error("revoked or unavailable"));
    await expect(finish(reservation.receipt)).rejects.toThrow("revoked or unavailable");
    calls.stored.mockResolvedValue(source());
    await expect(finish(reservation.receipt)).rejects.toThrow();
  });
  it("refuses revoked target consent during the transfer", async () => {
    const reservation = await begin(await issue());
    calls.consent.mockResolvedValue({ revoked: true, decidedAt: "target-1", granted: [] });
    await expect(finish(reservation.receipt)).rejects.toThrow();
  });
  it("refuses a changed target consent revision even when the new consent grants the same permission", async () => {
    const reservation = await begin(await issue());
    calls.consent.mockResolvedValue({ revoked: false, decidedAt: "target-2", granted: ["identity.basic", "service_operation.media.write"] });
    await expect(finish(reservation.receipt)).rejects.toThrow("authorization changed");
  });
  it("refuses a removed target permission before returning any execution decision", async () => {
    const reservation = await begin(await issue());
    calls.permissions.mockResolvedValue({ permissions: [{ key: "identity.basic", allowed: true }, { key: "service_operation.media.write", allowed: false }] });
    await expect(finish(reservation.receipt)).rejects.toThrow();
  });
  it("denies a policy that was reduced while bytes were in transit", async () => {
    const reservation = await begin(await issue()), project = target();
    project.schemaDefinition.service_operations[0]!.upload.maximumBytes = 32; calls.project.mockResolvedValue(project);
    await expect(finish(reservation.receipt)).rejects.toThrow("policy changed");
  });
  it("allows only one concurrent finalization", async () => {
    const reservation = await begin(await issue());
    const results = await Promise.allSettled([finish(reservation.receipt), finish(reservation.receipt)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });
  it("cancellation never grants a later execution", async () => {
    const other = await begin(await issue());
    expect((await route("cancel-upload", { receipt: other.receipt, requestBinding })).data).toEqual({ cancelled: true });
    await expect(finish(other.receipt)).rejects.toThrow();
  });
});
