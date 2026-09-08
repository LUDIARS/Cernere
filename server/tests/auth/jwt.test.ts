import { describe, it, expect, vi } from "vitest";
import jwt from "jsonwebtoken";
vi.mock("../../src/auth/user-session-state.js", () => ({
  currentUserSessionState: async (sub: string) => ({ sub, role: "general", authEpoch: 0, mfaRevision: 0 }),
  assertUserSessionCurrent: vi.fn(async () => {}),
}));
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
  it("round-trips sub + role and sets a 15m expiry", async () => {
    // user access token はステートレスで即時 revoke できないため 15 分に短縮した
    // (長期継続は refresh token 経由)。 service token (tool/project) は別枠で 60 分。
    const token = await generateAccessToken("user-1", "general");
    const claims = await verifyToken(token);
    expect(claims.sub).toBe("user-1");
    expect(claims.role).toBe("general");
    expect(claims.exp - claims.iat).toBe(15 * 60);
  });

  it("rejects a token signed with a different secret (forgery)", async () => {
    const forged = jwt.sign({ sub: "attacker", role: "admin" }, "some-other-secret");
    await expect(verifyToken(forged)).rejects.toThrow();
  });

  it("rejects a tampered token", async () => {
    const token = await generateAccessToken("user-1", "general");
    // 署名部 (3 つ目のセグメント) の末尾を 1 文字書き換える
    const parts = token.split(".");
    parts[2] = parts[2].slice(0, -1) + (parts[2].endsWith("a") ? "b" : "a");
    await expect(verifyToken(parts.join("."))).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const expired = jwt.sign({ sub: "user-1", role: "general" }, SECRET, { expiresIn: "-1s" });
    await expect(verifyToken(expired)).rejects.toThrow();
  });

  it("rejects a structurally invalid token", async () => {
    await expect(verifyToken("not-a-jwt")).rejects.toThrow();
  });
});

describe("auth/jwt — project token (HS256)", () => {
  it("round-trips clientId + projectKey with tokenType=project", async () => {
    const token = generateProjectToken("client-9", "memoria", 7);
    const claims = verifyProjectToken(token);
    expect(claims.sub).toBe("client-9");
    expect(claims.projectKey).toBe("memoria");
    expect(claims.credentialGeneration).toBe(7);
    expect(claims.tokenType).toBe("project");
  });

  it("rejects a plain access token as a project token (wrong tokenType)", async () => {
    const access = await generateAccessToken("user-1", "general");
    expect(() => verifyProjectToken(access)).toThrow(/Not a project token/);
  });
});

// NOTE: HS256 版の user×project token (旧 generateUserProjectToken /
// verifyUserProjectToken) は撤去した。 user×project token は PASETO Ed25519
// (aud 必須) に一本化したため、 検証は auth/paseto.test.ts を参照。

describe("auth/jwt — extractBearerToken", () => {
  it("extracts the token after 'Bearer '", async () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("returns null for a missing header", async () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it("returns null when the scheme is not Bearer", async () => {
    expect(extractBearerToken("Basic abc")).toBeNull();
    expect(extractBearerToken("abc.def.ghi")).toBeNull();
  });
});
