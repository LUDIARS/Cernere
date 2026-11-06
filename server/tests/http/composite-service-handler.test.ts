import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ values: new Map<string, string>(), ttl: [] as number[], revoked: false,
  permissions: [{ key: "profile.email", allowed: true }], projectKey: "glab" }));
vi.mock("../../src/logging/auth-logger.js", () => ({ logAuthEvent: vi.fn() }));
vi.mock("../../src/redis.js", () => ({
  redis: {
    set: async (key: string, value: string, _mode: string, ttl: number, nx?: string) => {
      if (nx === "NX" && state.values.has(key)) return null;
      state.values.set(key, value); state.ttl.push(ttl); return "OK";
    },
    getdel: async (key: string) => { const value = state.values.get(key) ?? null; state.values.delete(key); return value; },
  },
  checkRateLimit: async () => undefined,
}));
vi.mock("../../src/auth/composite-session.js", () => ({
  compositeSessionStore: { bind: async () => undefined, revoke: async () => undefined },
  currentCompositeSession: async () => {
    if (state.revoked) throw new Error("revoked or unavailable");
    return { project: { key: state.projectKey, schemaDefinition: { service_operations: [{ action: "profile.read", risk: "sensitive_read", permissions: ["profile.email"] }] } },
      grant: { source: { sub: "account" } }, grantId: "grant", identity: { subject: "user" },
      consent: { granted: ["profile.email"] }, permissions: state.permissions, expiresAt: Date.now() + 600_000 };
  },
}));
const { handleCompositeServiceRoute } = await import("../../src/http/composite-service-handler.js");
const input = { projectToken: "project-token", sessionBinding: "s".repeat(43), action: "profile.read", resource: "profile:1",
  contentDigest: "d".repeat(43), requestId: "11111111-1111-4111-8111-111111111111" };
const call = (phase: string, value: object) => handleCompositeServiceRoute(phase, JSON.stringify(value), "Bearer project-credential");
async function authorize(): Promise<string> { const result = await call("authorize", input); return (result.data as { permit: string }).permit; }
beforeEach(() => { state.values.clear(); state.ttl = []; state.revoked = false; state.permissions = [{ key: "profile.email", allowed: true }]; state.projectKey = "glab"; });

describe("service operation permits", () => {
  it("creates a 30-second permit and consumes it once", async () => {
    const permit = await authorize();
    expect(state.ttl).toContain(30);
    expect((await call("consume", { ...input, permit })).data).toEqual({ allowed: true, requestId: input.requestId, risk: "sensitive_read" });
    await expect(call("consume", { ...input, permit })).rejects.toThrow(/already used/);
  });
  it("reserves a request ID once, including when its outcome is unknown", async () => {
    await authorize();
    await expect(authorize()).rejects.toMatchObject({ statusCode: 409, code: "operation_already_attempted" });
  });
  it.each([
    { resource: "profile:2" }, { contentDigest: "e".repeat(43) }, { sessionBinding: "t".repeat(43) },
    { requestId: "22222222-2222-4222-8222-222222222222" },
  ])("rejects a changed envelope %j", async changed => {
    const permit = await authorize();
    await expect(call("consume", { ...input, ...changed, permit })).rejects.toThrow(/does not match/);
  });
  it("does not accept a permit under another project", async () => {
    const permit = await authorize(); state.projectKey = "other";
    await expect(call("consume", { ...input, permit })).rejects.toThrow(/does not match/);
  });
  it("allows only one concurrent consumption", async () => {
    const permit = await authorize();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => call("consume", { ...input, permit })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });
  it("rechecks revocation and permission between authorization and consumption", async () => {
    const permit = await authorize(); state.revoked = true;
    await expect(call("consume", { ...input, permit })).rejects.toThrow("revoked or unavailable");
    state.revoked = false; state.permissions = [{ key: "profile.email", allowed: false }];
    await expect(call("consume", { ...input, permit })).rejects.toThrow(/not granted/);
  });
  it("denies an unclassified operation even if its HTTP request is a GET", async () => {
    await expect(call("authorize", { ...input, action: "unknown.get" })).rejects.toThrow(/not classified/);
    expect(state.values.size).toBe(0);
  });
});
