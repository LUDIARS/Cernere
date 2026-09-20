import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ values: new Map<string, string>(), ttls: new Map<string, number>() }));
vi.mock("../../src/redis.js", () => ({
  redis: {
    async set(key: string, value: string, _mode: "EX", ttl: number) { store.values.set(key, value); store.ttls.set(key, ttl); },
    async get(key: string) { return store.values.get(key) ?? null; },
    async del(key: string) { store.values.delete(key); store.ttls.delete(key); },
  },
  checkRateLimit: async () => {},
}));
import { issueEnterpriseSession, readEnterpriseSession, enterpriseSessionKey } from "../../src/enterprise/session-store.js";

const uuid = "12345678-1234-4234-8234-123456789012";
const record = (expiresAt: number) => ({
  userId: uuid, projectKey: "demo", organizationId: uuid, connectionRevision: uuid, identityRevision: uuid,
  subjectHash: "a".repeat(64), organizationRole: "member", memberJoinedAt: "2020-01-01T00:00:00.000Z",
  authenticationRevision: 1, authTime: expiresAt - 600, amr: ["mfa"], expiresAt,
});

beforeEach(() => { store.values.clear(); store.ttls.clear(); });

describe("enterprise session store", () => {
  it("gives the session its full remaining lifetime regardless of sub-second clock offset", async () => {
    // A fractional `now` must not shave a second off the TTL; rotation would compound the loss.
    for (const millis of [0, 1, 123, 999]) {
      const now = 1800000000000 + millis;
      const token = await issueEnterpriseSession(record(Math.floor(now / 1000) + 600), now);
      expect(store.ttls.get(enterpriseSessionKey(token))).toBe(600);
    }
  });

  it("refuses to issue a session whose deadline has already passed", async () => {
    const now = 1800000000000;
    await expect(issueEnterpriseSession(record(Math.floor(now / 1000)), now)).rejects.toThrow();
  });

  it("rejects a stored session once its absolute deadline passes", async () => {
    const now = 1800000000000;
    const expiresAt = Math.floor(now / 1000) + 600;
    const token = await issueEnterpriseSession(record(expiresAt), now);
    await expect(readEnterpriseSession(token, expiresAt * 1000)).rejects.toThrow();
    expect(await readEnterpriseSession(token, expiresAt * 1000 - 1)).toMatchObject({ projectKey: "demo" });
  });

  it("refuses malformed tokens without touching the store", async () => {
    await expect(readEnterpriseSession("ordinary.jwt.token")).rejects.toThrow();
  });
});
