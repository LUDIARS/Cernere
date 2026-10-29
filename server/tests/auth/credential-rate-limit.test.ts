import { beforeEach, describe, expect, it, vi } from "vitest";

const counters = vi.hoisted(() => new Map<string, number>());
vi.mock("../../src/redis.js", () => ({
  checkRateLimit: vi.fn(async (key: string, max: number) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    if (next > max) throw new Error("Rate limit exceeded. Please try again later.");
  }),
  isRateLimited: vi.fn(async (key: string, max: number) => (counters.get(`ratelimit:${key}`) ?? 0) >= max),
  recordRateLimitHit: vi.fn(async (key: string) => {
    counters.set(`ratelimit:${key}`, (counters.get(`ratelimit:${key}`) ?? 0) + 1);
  }),
}));

const { beforeCredentialCheck, recordCredentialFailure } = await import("../../src/auth/credential-rate-limit.js");

describe("service credential rate limits", () => {
  beforeEach(() => counters.clear());

  it("lets the real service in while an outsider keeps failing with its client_id", async () => {
    for (let i = 0; i < 10; i++) {
      await beforeCredentialCheck("project_login", "proj_memoria_1234abcd", "203.0.113.7");
      await recordCredentialFailure("project_login", "proj_memoria_1234abcd", "203.0.113.7");
    }
    await expect(beforeCredentialCheck("project_login", "proj_memoria_1234abcd", "203.0.113.7")).rejects.toThrow(/Rate limit/);
    // 本物のサービスは別の接続元から来るので止まらない。
    await expect(beforeCredentialCheck("project_login", "proj_memoria_1234abcd", "198.51.100.20")).resolves.toBeUndefined();
  });

  it("does not count successful attempts as failures", async () => {
    for (let i = 0; i < 50; i++) await beforeCredentialCheck("service_token", "proj_a_1", "198.51.100.20");
    await expect(beforeCredentialCheck("service_token", "proj_a_1", "198.51.100.20")).resolves.toBeUndefined();
  });

  it("caps all attempts from one source, grouping an IPv6 /64", async () => {
    for (let i = 0; i < 120; i++) await beforeCredentialCheck("project_login", `proj_${i}`, `2001:db8:1:2::${(i % 200).toString(16)}`);
    await expect(beforeCredentialCheck("project_login", "proj_x", "2001:db8:1:2:ffff::1")).rejects.toThrow(/Rate limit/);
  });
});
