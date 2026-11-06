import type { Redis } from "ioredis";
import type { CompositeSessionCommands } from "./composite-session-store.js";

const revokeScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
  return 1
end
return 0`;

/** The fixed Redis transaction adapter owns all persistence/TTL primitives.
 * Script source is constant and never comes from a policy, request or fixture.
 * @implements SPEC-COMPOSITE-OPERATION-GUARD
 */
export class RedisCompositeSessionCommands implements CompositeSessionCommands {
  constructor(private readonly redis: Pick<Redis, "set" | "get" | "eval">) {}
  async createIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    return await this.redis.set(key, value, "EX", ttlSeconds, "NX") === "OK";
  }
  read(key: string): Promise<string | null> { return this.redis.get(key); }
  async compareAndRevoke(key: string, active: string, revoked: string): Promise<boolean> {
    // Redis evaluates its fixed Lua transaction server-side; no JS evaluation.
    return await this.redis.eval(revokeScript, 1, key, active, revoked) === 1;
  }
}
