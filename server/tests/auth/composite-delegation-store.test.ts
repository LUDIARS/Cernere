import { describe, expect, it, vi } from "vitest";
vi.mock("../../src/redis.js", () => ({ redis: {} }));
import { ActionProofStore } from "../../src/auth/action-proof.js";
import { CompositeDelegationStore, delegatedOperationSchema, type DelegationRecord } from "../../src/auth/composite-delegation-store.js";

function fixture() {
  let now = Date.now();
  let entropy = 1;
  const values = new Map<string, { value: string; expiresAt: number }>();
  const redis = {
    set: async (key: string, value: string, _mode: "EX", ttl: number) => { values.set(key, { value, expiresAt: now + ttl * 1000 }); return "OK"; },
    get: async (key: string) => { const entry = values.get(key); return entry && entry.expiresAt > now ? entry.value : null; },
    getdel: async (key: string) => { const entry = values.get(key); values.delete(key); return entry && entry.expiresAt > now ? entry.value : null; },
  };
  const proofs = new ActionProofStore({ redisClient: redis, randomBytes: () => Buffer.alloc(32, entropy++), now: () => new Date(now), ttlSeconds: 30 });
  const store = new CompositeDelegationStore(redis, proofs, () => now);
  const record: DelegationRecord = { version: 1,
    source: { projectKey: "glab", audience: "https://glab.example", credentialGeneration: 2, grantId: "11111111-1111-4111-8111-111111111111",
      sessionBinding: "s".repeat(43), userId: "account", subjectId: "subject", expiresAt: now + 900_000 },
    target: { projectKey: "aedilis", audience: "https://aedilis.example", credentialGeneration: 3, consentRevision: "target-1" },
    operation: { action: "records.read", method: "GET", path: "/api/records/1?detail=1", resource: "/api/records/1?detail=1", contentDigest: "d".repeat(43), headersDigest: "h".repeat(43), requestId: "22222222-2222-4222-8222-222222222222" },
    risk: "sensitive_read", issuedAt: now, expiresAt: now + 30_000 };
  return { store, values, record, advance: (ms: number) => { now += ms; } };
}
describe("delegation one-operation storage", () => {
  it("uses an existing one-use proof and never embeds credentials in its public token", async () => {
    const { store, record } = fixture();
    const token = await store.issue(record);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await store.read(token)).toEqual(record);
    await store.consume(token, await store.read(token));
    await expect(store.consume(token, record)).rejects.toThrow();
  });
  it("permits only one concurrent consume even though both callers can read metadata", async () => {
    const { store, record } = fixture();
    const token = await store.issue(record);
    const records = await Promise.all([store.read(token), store.read(token)]);
    const results = await Promise.allSettled(records.map(value => store.consume(token, value)));
    expect(results.filter(value => value.status === "fulfilled")).toHaveLength(1);
  });
  it("does not authorize changed source, target or operation metadata", async () => {
    const { store, record } = fixture();
    const token = await store.issue(record);
    const changed = { ...record, operation: { ...record.operation, method: "DELETE" as const } };
    await expect(store.consume(token, changed)).rejects.toThrow();
    await expect(store.consume(token, record)).rejects.toThrow();
  });
  it("never accepts a capability beyond thirty seconds or beyond its source expiry", async () => {
    const { store, record, advance } = fixture();
    await expect(store.issue({ ...record, expiresAt: record.issuedAt + 30_001 })).rejects.toThrow();
    await expect(store.issue({ ...record, source: { ...record.source, expiresAt: record.issuedAt + 1000 } })).rejects.toThrow();
    const token = await store.issue(record);
    advance(30_000);
    await expect(store.read(token)).rejects.toThrow();
    await expect(store.consume(token, record)).rejects.toThrow();
  });
  it.each(["//other.example/path", "/a/../b", "/path#fragment", "https://other.example/path"])("rejects noncanonical delegated path %s", path => {
    const { record } = fixture();
    expect(delegatedOperationSchema.safeParse({ ...record.operation, path, resource: path }).success).toBe(false);
  });
  it("binds the complete query and requires resource to equal the actual request path", () => {
    const { record } = fixture();
    expect(delegatedOperationSchema.safeParse(record.operation).success).toBe(true);
    expect(delegatedOperationSchema.safeParse({ ...record.operation, resource: "/api/records/1" }).success).toBe(false);
  });
  it("fails closed for missing or malformed metadata", async () => {
    const { store, record, values } = fixture();
    await expect(store.read("t".repeat(43))).rejects.toThrow();
    const token = await store.issue(record);
    for (const [key, value] of values) if (key.startsWith("composite-delegation:")) values.set(key, { ...value, value: "{}" });
    await expect(store.read(token)).rejects.toThrow();
  });
});
