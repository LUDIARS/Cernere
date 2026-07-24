import { describe, expect, it } from "vitest";

import {
  ActionProofStore,
  type ActionProofRedis,
} from "../../src/auth/action-proof.js";

class FakeRedis implements ActionProofRedis {
  readonly values = new Map<string, string>();
  lastTtl: number | undefined;

  async set(key: string, value: string, _mode: "EX", ttlSeconds: number): Promise<void> {
    this.values.set(key, value);
    this.lastTtl = ttlSeconds;
  }

  async getdel(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }
}

const expected = {
  userId: "user-1",
  binding: "ws:session-1",
  action: "managed_project.delete" as const,
  resource: "project-1",
};

describe("ActionProofStore", () => {
  it("issues an opaque proof with the configured short TTL", async () => {
    const redis = new FakeRedis();
    const store = new ActionProofStore({
      redisClient: redis,
      randomBytes: () => Buffer.alloc(32, 7),
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      ttlSeconds: 300,
    });

    const issued = await store.issue(expected);

    expect(issued.proof).not.toContain("user-1");
    expect(issued.expiresIn).toBe(300);
    expect(redis.lastTtl).toBe(300);
  });

  it("accepts the matching proof once and rejects replay", async () => {
    const redis = new FakeRedis();
    const store = new ActionProofStore({ redisClient: redis });
    const { proof } = await store.issue(expected);

    await expect(store.consume(proof, expected)).resolves.toBeUndefined();
    await expect(store.consume(proof, expected)).rejects.toThrow("already used");
  });

  it("consumes and rejects a proof bound to another operation", async () => {
    const redis = new FakeRedis();
    const store = new ActionProofStore({ redisClient: redis });
    const { proof } = await store.issue(expected);
    const wrongOperation = { ...expected, resource: "project-2" };

    await expect(store.consume(proof, wrongOperation)).rejects.toThrow("does not match");
    await expect(store.consume(proof, expected)).rejects.toThrow("already used");
  });
});
