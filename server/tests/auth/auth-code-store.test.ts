import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuthCodeStore, COMPOSITE_AUTH_CODE_TTL_SECONDS, type AuthCodeBinding } from "../../src/auth/auth-code-store.js";

const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
const subject = { sub: "account-1", role: "general", authEpoch: 3 };
const code = "a".repeat(43);
const service: AuthCodeBinding = { audience: "service", projectKey: "glab", origin: "https://glab.example", codeChallenge };

function setup() {
  const values = new Map<string, string>();
  const writes: Array<{ value: string; seconds: number }> = [];
  const store = new AuthCodeStore({
    async set(key, value, _expiry, seconds) { values.set(key, value); writes.push({ value, seconds }); },
    async getdel(key) { const value = values.get(key) ?? null; values.delete(key); return value; },
  }, () => code);
  return { store, values, writes };
}

describe("Composite authorization code isolation", () => {
  it("stores only the bound subject for 60 seconds, without credentials", async () => {
    const { store, writes } = setup();
    await store.issue(service, subject);
    expect(writes[0]?.seconds).toBe(COMPOSITE_AUTH_CODE_TTL_SECONDS);
    expect(writes[0]?.value).not.toMatch(/accessToken|refreshToken/);
    expect(await store.consume(code, { audience: "service", projectKey: "glab", codeVerifier: verifier })).toMatchObject({ binding: service, subject });
  });

  it.each([
    { audience: "service" as const, projectKey: "other", codeVerifier: verifier },
    { audience: "service" as const, projectKey: "glab", codeVerifier: "x".repeat(43) },
    { audience: "service" as const, projectKey: "glab", codeVerifier: "short" },
    { audience: "cernere" as const, origin: "https://glab.example", codeVerifier: verifier },
    { audience: "kiosk" as const, projectKey: "glab" },
  ])("rejects and consumes mismatched exchange %j", async expected => {
    const { store } = setup();
    await store.issue(service, subject);
    expect(await store.consume(code, expected)).toBeNull();
    expect(await store.consume(code, { audience: "service", projectKey: "glab", codeVerifier: verifier })).toBeNull();
  });

  it("allows only one concurrent exchange", async () => {
    const { store } = setup();
    await store.issue(service, subject);
    const results = await Promise.all(Array.from({ length: 8 }, () => store.consume(code, { audience: "service", projectKey: "glab", codeVerifier: verifier })));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it.each(["https://other.example", ""])("requires the exact self origin", async origin => {
    const { store } = setup();
    await store.issue({ audience: "cernere", origin: "https://cernere.example", codeChallenge }, subject);
    expect(await store.consume(code, { audience: "cernere", origin, codeVerifier: verifier })).toBeNull();
  });

  it("accepts only an explicitly kiosk-bound code at the kiosk endpoint", async () => {
    const { store } = setup();
    await store.issue({ audience: "kiosk", projectKey: "ostiarius" }, subject);
    expect(await store.consume(code, { audience: "kiosk", projectKey: "ostiarius" })).toMatchObject({ subject });
  });

  it.each(["{}", "null", "broken", JSON.stringify({ audience: "service", accessToken: "legacy" })])("rejects legacy and malformed records: %s", async raw => {
    const { store, values } = setup();
    values.set(`authcode:${code}`, raw);
    expect(await store.consume(code, { audience: "service", projectKey: "glab", codeVerifier: verifier })).toBeNull();
  });
});
