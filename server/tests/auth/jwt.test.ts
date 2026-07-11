import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import {
  generateAccessToken,
  verifyToken,
  generateProjectToken,
  verifyProjectToken,
  extractBearerToken,
} from "../../src/auth/jwt";

// vitest.config.ts の test.env で固定。config.jwtSecret も同じ値になる。
const SECRET = process.env.JWT_SECRET as string;

describe("auth/jwt — access token", () => {
  it("round-trips sub + role and sets a 15m expiry", () => {
    // user access token はステートレスで即時 revoke できないため 15 分に短縮した
    // (長期継続は refresh token 経由)。 service token (tool/project) は別枠で 60 分。
    const token = generateAccessToken("user-1", "general");
    const claims = verifyToken(token);
    expect(claims.sub).toBe("user-1");
    expect(claims.role).toBe("general");
    expect(claims.exp - claims.iat).toBe(15 * 60);
  });

  it("rejects a token signed with a different secret (forgery)", () => {
    const forged = jwt.sign({ sub: "attacker", role: "admin" }, "some-other-secret");
    expect(() => verifyToken(forged)).toThrow();
  });

  it("rejects a tampered token", () => {
    const token = generateAccessToken("user-1", "general");
    // 署名部 (3 つ目のセグメント) の末尾を 1 文字書き換える
    const parts = token.split(".");
    parts[2] = parts[2].slice(0, -1) + (parts[2].endsWith("a") ? "b" : "a");
    expect(() => verifyToken(parts.join("."))).toThrow();
  });

  it("rejects an expired token", () => {
    const expired = jwt.sign({ sub: "user-1", role: "general" }, SECRET, { expiresIn: "-1s" });
    expect(() => verifyToken(expired)).toThrow();
  });

  it("rejects a structurally invalid token", () => {
    expect(() => verifyToken("not-a-jwt")).toThrow();
  });
});

describe("auth/jwt — project token (HS256)", () => {
  it("round-trips clientId + projectKey with tokenType=project", () => {
    const token = generateProjectToken("client-9", "memoria", 7);
    const claims = verifyProjectToken(token);
    expect(claims.sub).toBe("client-9");
    expect(claims.projectKey).toBe("memoria");
    expect(claims.credentialGeneration).toBe(7);
    expect(claims.tokenType).toBe("project");
  });

  it("rejects a plain access token as a project token (wrong tokenType)", () => {
    const access = generateAccessToken("user-1", "general");
    expect(() => verifyProjectToken(access)).toThrow(/Not a project token/);
  });
});

// NOTE: HS256 版の user×project token (旧 generateUserProjectToken /
// verifyUserProjectToken) は撤去した。 user×project token は PASETO Ed25519
// (aud 必須) に一本化したため、 検証は auth/paseto.test.ts を参照。

describe("auth/jwt — extractBearerToken", () => {
  it("extracts the token after 'Bearer '", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("returns null for a missing header", () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it("returns null when the scheme is not Bearer", () => {
    expect(extractBearerToken("Basic abc")).toBeNull();
    expect(extractBearerToken("abc.def.ghi")).toBeNull();
  });
});
