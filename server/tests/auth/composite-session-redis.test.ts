import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { RedisCompositeSessionCommands } from "../../src/auth/composite-session-redis.js";

function setup() {
  const redis = { set: vi.fn(), get: vi.fn(), eval: vi.fn() };
  const commands = new RedisCompositeSessionCommands(redis as unknown as Pick<Redis, "set" | "get" | "eval">);
  return { redis, commands };
}

describe("Redis service binding adapter", () => {
  it("creates with NX and the bounded TTL, and never interprets another reply as success", async () => {
    const { redis, commands } = setup();
    redis.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null).mockResolvedValueOnce("unknown");
    await expect(commands.createIfAbsent("key", "active:a", 20)).resolves.toBe(true);
    expect(redis.set).toHaveBeenLastCalledWith("key", "active:a", "EX", 20, "NX");
    await expect(commands.createIfAbsent("key", "active:b", 20)).resolves.toBe(false);
    await expect(commands.createIfAbsent("key", "active:b", 20)).resolves.toBe(false);
  });
  it("uses one fixed compare-and-tombstone transaction and preserves Redis TTL", async () => {
    const { redis, commands } = setup();
    redis.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValueOnce("1");
    await expect(commands.compareAndRevoke("key", "active:a", "revoked:a")).resolves.toBe(true);
    const call = redis.eval.mock.calls[0]!;
    expect(call.slice(1)).toEqual([1, "key", "active:a", "revoked:a"]);
    expect(call[0]).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
    expect(call[0]).toContain("redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')");
    expect(call[0]).not.toContain("EXPIRE");
    await expect(commands.compareAndRevoke("key", "active:b", "revoked:b")).resolves.toBe(false);
    await expect(commands.compareAndRevoke("key", "active:a", "revoked:a")).resolves.toBe(false);
    expect(redis.eval.mock.calls[1]![0]).toBe(call[0]);
  });
  it("surfaces persistence failures instead of granting from a stale result", async () => {
    const { redis, commands } = setup();
    redis.get.mockRejectedValue(new Error("offline"));
    redis.eval.mockRejectedValue(new Error("offline"));
    await expect(commands.read("key")).rejects.toThrow("offline");
    await expect(commands.compareAndRevoke("key", "active:a", "revoked:a")).rejects.toThrow("offline");
  });
});
