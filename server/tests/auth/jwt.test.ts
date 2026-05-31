import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import {
  generateAccessToken,
  verifyToken,
  generateProjectToken,
  verifyProjectToken,
  generateUserProjectToken,
  verifyUserProjectToken,
  extractBearerToken,
} from "../../src/auth/jwt";

// vitest.config.ts の test.env で固定。config.jwtSecret も同じ値になる。
const SECRET = process.env.JWT_SECRET as string;

describe("auth/jwt — access token", () => {
  it("round-trips sub + role and sets a ~60m expiry", () => {
    const token = generateAccessToken("user-1", "general");
    const claims = verifyToken(token);
    expect(claims.sub).toBe("user-1");
    expect(claims.role).toBe("general");
    expect(claims.exp - claims.iat).toBe(60 * 60);
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
    const token = generateProjectToken("client-9", "memoria");
    const claims = verifyProjectToken(token);
    expect(claims.sub).toBe("client-9");
    expect(claims.projectKey).toBe("memoria");
    expect(claims.tokenType).toBe("project");
  });

  it("rejects a plain access token as a project token (wrong tokenType)", () => {
    const access = generateAccessToken("user-1", "general");
    expect(() => verifyProjectToken(access)).toThrow(/Not a project token/);
  });

  it("rejects a user_for_project token as a project token", () => {
    const up = generateUserProjectToken("user-1", "memoria", "general");
    expect(() => verifyProjectToken(up)).toThrow(/Not a project token/);
  });
});

describe("auth/jwt — user_for_project token", () => {
  it("round-trips userId + projectKey + role with kind=user_for_project", () => {
    const token = generateUserProjectToken("user-7", "memoria", "admin");
    const claims = verifyUserProjectToken(token);
    expect(claims.sub).toBe("user-7");
    expect(claims.projectKey).toBe("memoria");
    expect(claims.role).toBe("admin");
    expect(claims.kind).toBe("user_for_project");
  });

  it("rejects a plain access token (missing kind claim)", () => {
    const access = generateAccessToken("user-1", "general");
    expect(() => verifyUserProjectToken(access)).toThrow(/Not a user_for_project token/);
  });

  it("rejects a project token as a user_for_project token", () => {
    const proj = generateProjectToken("client-9", "memoria");
    expect(() => verifyUserProjectToken(proj)).toThrow(/Not a user_for_project token/);
  });

  it("rejects a forged user_for_project token (wrong secret)", () => {
    const forged = jwt.sign(
      { sub: "attacker", projectKey: "memoria", role: "admin", kind: "user_for_project" },
      "some-other-secret",
      { algorithm: "HS256" },
    );
    expect(() => verifyUserProjectToken(forged)).toThrow(/Invalid or expired user_for_project token/);
  });
});

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
