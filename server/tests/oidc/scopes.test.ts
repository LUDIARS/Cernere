import { describe, it, expect } from "vitest";
import {
  buildClaims,
  parseScope,
  intersectScopes,
  verifyPkceS256,
  discoveryDocument,
  SUPPORTED_SCOPES,
  type ClaimSourceUser,
} from "../../src/oidc/scopes";

const baseUser: ClaimSourceUser = {
  id: "user-123",
  email: "a@example.com",
  displayName: "Alice",
  login: "alice",
  avatarUrl: "https://example.com/a.png",
  hasVerifiedIdentity: true,
};

describe("buildClaims", () => {
  it("always includes sub and nothing else for openid only", () => {
    expect(buildClaims(baseUser, ["openid"])).toEqual({ sub: "user-123" });
  });

  it("includes email + email_verified for email scope", () => {
    const c = buildClaims(baseUser, ["openid", "email"]);
    expect(c.email).toBe("a@example.com");
    expect(c.email_verified).toBe(true);
  });

  it("marks email_verified false when identity not federated", () => {
    const c = buildClaims({ ...baseUser, hasVerifiedIdentity: false }, ["email"]);
    expect(c.email_verified).toBe(false);
  });

  it("omits email when user has none", () => {
    const c = buildClaims({ ...baseUser, email: null }, ["email"]);
    expect(c.email).toBeUndefined();
    expect(c.email_verified).toBeUndefined();
  });

  it("includes profile claims for profile scope", () => {
    const c = buildClaims(baseUser, ["profile"]);
    expect(c.name).toBe("Alice");
    expect(c.preferred_username).toBe("alice");
    expect(c.picture).toBe("https://example.com/a.png");
  });
});

describe("parseScope / intersectScopes", () => {
  it("drops unsupported scopes", () => {
    expect(parseScope("openid email offline_access profile")).toEqual(["openid", "email", "profile"]);
  });
  it("handles empty input", () => {
    expect(parseScope(undefined)).toEqual([]);
  });
  it("intersects with client-allowed scopes", () => {
    expect(intersectScopes(["openid", "email", "profile"], ["openid", "email"])).toEqual(["openid", "email"]);
  });
});

describe("verifyPkceS256", () => {
  // RFC 7636 Appendix B の test vector
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("accepts the matching verifier", () => {
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });
  it("rejects a wrong verifier", () => {
    expect(verifyPkceS256("wrong-verifier", challenge)).toBe(false);
  });
});

describe("discoveryDocument", () => {
  it("advertises only the supported, secure capabilities", () => {
    const d = discoveryDocument();
    expect(d.response_types_supported).toEqual(["code"]);
    expect(d.id_token_signing_alg_values_supported).toEqual(["RS256"]);
    expect(d.code_challenge_methods_supported).toEqual(["S256"]);
    expect(d.scopes_supported).toEqual([...SUPPORTED_SCOPES]);
    const issuer = d.issuer as string;
    expect(d.authorization_endpoint).toBe(`${issuer}/oidc/authorize`);
    expect(d.token_endpoint).toBe(`${issuer}/oidc/token`);
    expect(d.jwks_uri).toBe(`${issuer}/.well-known/jwks.json`);
  });
});
