import { describe, expect, it } from "vitest";
import { PasskeyLoginChallengeStore, type PasskeyLoginIntent } from "../../src/auth/passkey-login-challenge.js";

function fixture() {
  const records = new Map<string, string>();
  const store = new PasskeyLoginChallengeStore({
    set: async (key, value) => { records.set(key, value); },
    getdel: async key => { const value = records.get(key) ?? null; records.delete(key); return value; },
  }, 300);
  return { store, records };
}
const global: PasskeyLoginIntent = { binding: null, expectedOrigins: ["https://cr.example"], embeddingOrigins: null, request: null };
const serviceBinding = { audience: "service" as const, projectKey: "a", origin: "https://a.example", codeChallenge: "c".repeat(43) };
const serviceRequest = { target: "https://a.example", targetMode: "post_message", state: "state", codeChallenge: "c".repeat(43) };
const service: PasskeyLoginIntent = { binding: serviceBinding, expectedOrigins: ["https://a.example"], embeddingOrigins: ["https://a.example"], request: serviceRequest };
describe("one-use challenge purpose and destination binding", () => {
  it("keeps ordinary global login and matching Composite completion", async () => {
    const { store } = fixture();
    for (const intent of [global, service]) {
      await store.issue("owner", "challenge", intent);
      expect(await store.consume("owner", intent)).toBe("challenge");
      await expect(store.consume("owner", intent)).rejects.toThrow();
    }
  });
  it.each([global, { ...service, binding: { audience: "cernere", origin: "https://cr.example", codeChallenge: "c".repeat(43) } } satisfies PasskeyLoginIntent])("cannot promote a service challenge to self/global", async intent => {
    const { store } = fixture();
    await store.issue("owner", "challenge", service);
    await expect(store.consume("owner", intent)).rejects.toThrow("purpose or destination");
    await expect(store.consume("owner", service)).rejects.toThrow();
  });
  it("cannot turn a global challenge into a service challenge", async () => {
    const { store } = fixture();
    await store.issue("owner", "challenge", global);
    await expect(store.consume("owner", service)).rejects.toThrow();
  });
  const changes: PasskeyLoginIntent[] = [
    { ...service, binding: { ...serviceBinding, projectKey: "b" } },
    { ...service, expectedOrigins: ["https://b.example"] },
    { ...service, embeddingOrigins: ["https://b.example"] },
    { ...service, request: { ...serviceRequest, codeChallenge: "d".repeat(43) } },
    { ...service, request: { ...serviceRequest, target: "https://b.example" } },
    { ...service, request: { ...serviceRequest, state: "other-state" } },
    { ...service, request: { ...serviceRequest, targetMode: "redirect" } },
  ];
  it.each(changes)("rejects changing project, origin, PKCE or handoff fields", async intent => {
    const { store } = fixture();
    await store.issue("owner", "challenge", service);
    await expect(store.consume("owner", intent)).rejects.toThrow();
  });
  it("allows only one concurrent completion", async () => {
    const { store } = fixture();
    await store.issue("owner", "challenge", service);
    const results = await Promise.allSettled([store.consume("owner", service), store.consume("owner", service)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });
  it.each(["legacy-challenge", "null", "{}"])("rejects legacy or malformed records", async raw => {
    const { store, records } = fixture();
    records.set("passkey:challenge:login:owner", raw);
    await expect(store.consume("owner", global)).rejects.toThrow();
  });
});
