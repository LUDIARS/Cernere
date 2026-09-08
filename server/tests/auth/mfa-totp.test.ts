import { describe, expect, it } from "vitest";
import { totpProvisioningUri, verifyTotpStep } from "../../src/auth/mfa-totp.js";

// Public RFC 6238 Appendix B interoperability fixture, never an account credential.
// ASCII 12345678901234567890 encoded as Base32. SHA1 outputs use 6 digits here.
const RFC_FIXTURE = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("Authenticator TOTP interoperability", () => {
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ] as const)("accepts the RFC SHA1 value at %i seconds", (seconds, code) => {
    expect(verifyTotpStep(RFC_FIXTURE, code, -1, seconds * 1000)).toBe(Math.floor(seconds / 30));
  });

  it("rejects a successfully used time step across separate challenges", () => {
    expect(verifyTotpStep(RFC_FIXTURE, "287082", 1, 59_000)).toBeNull();
    expect(verifyTotpStep(RFC_FIXTURE, "287082", 2, 59_000)).toBeNull();
  });

  it("limits clock skew to one adjacent step", () => {
    expect(verifyTotpStep(RFC_FIXTURE, "287082", -1, 29_000)).toBe(1);
    expect(verifyTotpStep(RFC_FIXTURE, "287082", -1, 89_000)).toBe(1);
    expect(verifyTotpStep(RFC_FIXTURE, "287082", -1, 90_000)).toBeNull();
  });

  it.each(["94287082", "28708", " 287082", "２８７０８２", "000000"])("rejects invalid input %s", (code) => {
    expect(verifyTotpStep(RFC_FIXTURE, code, -1, 59_000)).toBeNull();
  });

  it("encodes an account label without changing the enrollment query", () => {
    const uri = new URL(totpProvisioningUri(RFC_FIXTURE, "a+b&issuer=attacker@example.com"));
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.hostname).toBe("totp");
    expect(uri.searchParams.get("issuer")).toBe("Cernere");
    expect(uri.searchParams.get("secret")).toBe(RFC_FIXTURE);
    expect(uri.searchParams.get("digits")).toBe("6");
    expect(uri.searchParams.get("period")).toBe("30");
  });
});
