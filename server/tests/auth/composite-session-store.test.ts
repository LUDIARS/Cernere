import { describe, expect, it } from "vitest";
import { CompositeSessionStore } from "../../src/auth/composite-session-store.js";

function setup() {
  const values = new Map<string, { value: string; ttl: number }>();
  const store = new CompositeSessionStore({
    async createIfAbsent(key, value, ttl) {
      if (values.has(key)) return false;
      values.set(key, { value, ttl }); return true;
    },
    async read(key) { return values.get(key)?.value ?? null; },
    async compareAndRevoke(key, active, revoked) {
      const value = values.get(key);
      if (!value || value.value !== active) return false;
      values.set(key, { ...value, value: revoked }); return true;
    },
  });
  return { store, values };
}
describe("one grant, one service session", () => {
  it("accepts the same binding retry without extending its lifetime", async () => {
    const { store, values } = setup();
    await store.bind("grant", "session-a", 20);
    await store.bind("grant", "session-a", 900);
    expect(values.get("composite-session:grant")?.ttl).toBe(20);
  });
  it("allows only one competing binding", async () => {
    const { store } = setup();
    const results = await Promise.allSettled([store.bind("grant", "a", 20), store.bind("grant", "b", 20)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    await expect(store.requireBound("grant", "b")).rejects.toMatchObject({ statusCode: 401 });
  });
  it("leaves a tombstone so a logged-out grant cannot be reused", async () => {
    const { store, values } = setup();
    await store.bind("grant", "a", 20);
    await store.revoke("grant", "a");
    expect(values.get("composite-session:grant")).toEqual({ value: "revoked:a", ttl: 20 });
    await expect(store.bind("grant", "a", 20)).rejects.toMatchObject({ statusCode: 401 });
    await expect(store.bind("grant", "b", 20)).rejects.toMatchObject({ statusCode: 401 });
    await expect(store.requireBound("grant", "a")).rejects.toMatchObject({ statusCode: 401 });
  });
  it("cannot revoke another service session", async () => {
    const { store } = setup();
    await store.bind("grant", "a", 20);
    await expect(store.revoke("grant", "b")).rejects.toMatchObject({ statusCode: 401 });
    await expect(store.requireBound("grant", "a")).resolves.toBeUndefined();
  });
});
