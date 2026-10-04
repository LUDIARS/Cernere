/**
 * MFA ticket / onsite challenge の Lua を JS で再現する最小 Redis モック。
 *
 * 実 Redis を立てずに「一回消費」「nonce の used 遷移」の分岐を観測するためのもの。
 * 各スクリプトは Redis 上で原子的に走るので、 ここでも 1 回の eval を同期的に処理する。
 */

// Scripts are recognised by content: importing them from src would re-enter the mocked redis module.
export class FakeMfaRedis {
  readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }

  async set(key: string, value: string): Promise<"OK"> { this.store.set(key, value); return "OK"; }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) if (this.store.delete(key)) removed += 1;
    return removed;
  }

  async eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<number> {
    const keys = args.slice(0, numKeys).map(String);
    const argv = args.slice(numKeys).map(String);
    if (script.includes("KEEPTTL")) return this.commit(keys, argv);
    if (script.includes("local previous")) return this.issue(keys, argv);
    if (script.includes("KEYS[4]")) return this.consume(keys, argv);
    if (script.includes("INCR")) {
      const next = Number(this.store.get(keys[0]) ?? "0") + 1;
      this.store.set(keys[0], String(next));
      return next;
    }
    throw new Error("FakeMfaRedis: unknown script");
  }

  private consume(keys: string[], argv: string[]): number {
    if (this.store.get(keys[0]) !== argv[0]) return 0;
    if (argv[1] !== "" && this.store.get(keys[1]) !== argv[1]) return 0;
    if (argv[2] !== "" && this.store.get(keys[3]) !== argv[2]) return 0;
    for (const key of keys) this.store.delete(key);
    return 1;
  }

  private issue(keys: string[], argv: string[]): number {
    const previous = this.store.get(keys[1]);
    if (previous) this.store.delete(previous);
    this.store.set(keys[0], argv[0]);
    this.store.set(keys[1], keys[0]);
    return 1;
  }

  private commit(keys: string[], argv: string[]): number {
    const bound = this.store.get(keys[0]);
    if (bound === "used") return -1;
    if (bound !== argv[0] || !this.store.has(keys[1])) return 0;
    this.store.set(keys[0], "used");
    this.store.set(keys[2], argv[1]);
    return 1;
  }
}
