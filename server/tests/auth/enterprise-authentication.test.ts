import { describe, it, expect } from "vitest";
import { completedAuthentication, readAuthenticationEvidence } from "../../src/lib/authentication-evidence.js";
import { isAuthenticationCurrent } from "../../src/lib/authentication-freshness.js";

describe("enterprise authentication evidence", () => {
  it("does not turn missing legacy facts or password-only login into MFA", () => {
    expect(readAuthenticationEvidence(undefined)).toBeUndefined();
    expect(completedAuthentication("password", 3, 1000).amr).not.toContain("mfa");
    expect(completedAuthentication("totp", 3, 1000).amr).toContain("mfa");
  });
  it("rejects a pre-request login even when it is within the same second", () => {
    const evidence = completedAuthentication("passkey", 3, 1001);
    expect(isAuthenticationCurrent(evidence, 3, { createdAtMs: 1002, forceReauth: true }, 1100)).toBe(false);
    expect(isAuthenticationCurrent(completedAuthentication("passkey", 3, 1050), 3,
      { createdAtMs: 1002, forceReauth: true }, 1100)).toBe(true);
  });
  it("preserves authentication age after serialization/refresh and rejects changed credentials", () => {
    const evidence = readAuthenticationEvidence(JSON.parse(JSON.stringify(completedAuthentication("email", 3, 1000))))!;
    expect(isAuthenticationCurrent(evidence, 3, { createdAtMs: 1000, forceReauth: false, maxAge: 60 }, 61000)).toBe(false);
    expect(isAuthenticationCurrent(evidence, 4, undefined, 2000)).toBe(false);
    expect(isAuthenticationCurrent(evidence, 3, undefined, 999)).toBe(false);
  });
});
