import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/db/connection.js", () => ({ db: {} }));
vi.mock("../../src/config.js", () => ({ config: { deviceSessionsEnabled: true } }));
import { users } from "../../src/db/schema.js";
import { assertUserSessionCurrent, type SessionReader, type UserSessionState } from "../../src/auth/user-session-state.js";

const userId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const authentication = { authTime: 100, authTimeMs: 100_000, revision: 3, amr: ["pop", "mfa"] as ("pop" | "mfa")[] };
let user: { sub: string; role: string; authEpoch: number; mfaRevision: number };
let device: Record<string, unknown> | undefined;
let claims: UserSessionState;

// The reader supplies post-query records; SQL ownership/active-root filtering remains an integration check.
const reader = { select: () => ({ from: (table: unknown) => table === users
  ? { where: () => ({ limit: async () => [user] }) }
  : { innerJoin: () => ({ where: () => ({ limit: async () => device ? [{ device }] : [] }) }) } }) } as unknown as SessionReader;

// loadSessionKeyMaterial は key id を返す前に master key も検証するため、両方を stub する。
const sessionMasterKey = Buffer.alloc(32, 7).toString("base64url");

beforeEach(() => {
  vi.stubEnv("CERNERE_AUTH_SESSION_KEY", sessionMasterKey);
  vi.stubEnv("CERNERE_AUTH_SESSION_KEY_ID", "key-1");
  user = { sub: userId, role: "general", authEpoch: 4, mfaRevision: 3 };
  device = { authEpoch: 4, tokenKeyId: "key-1", authentication, expiresAt: new Date(Date.now() + 60_000) };
  claims = { ...user, deviceId, authentication };
});
afterEach(() => vi.unstubAllEnvs());

describe("current user session authorization", () => {
  it("accepts unchanged authorization without changing authentication time", async () => {
    await expect(assertUserSessionCurrent(claims, reader)).resolves.toBeUndefined();
    expect(claims.authentication?.authTimeMs).toBe(100_000);
  });
  it.each(["authEpoch", "mfaRevision"] as const)("rejects a changed %s", async key => {
    user[key]++;
    await expect(assertUserSessionCurrent(claims, reader)).rejects.toMatchObject({ statusCode: 401 });
  });
  it("rejects a changed role", async () => {
    user.role = "admin";
    await expect(assertUserSessionCurrent(claims, reader)).rejects.toMatchObject({ statusCode: 401 });
  });
  it("rejects a missing or revoked authentication root", async () => {
    device = undefined;
    await expect(assertUserSessionCurrent(claims, reader)).rejects.toMatchObject({ statusCode: 401 });
  });
  it("rejects the original absolute deadline", async () => {
    device!.expiresAt = new Date(Date.now() - 1);
    await expect(assertUserSessionCurrent(claims, reader)).rejects.toMatchObject({ statusCode: 401 });
  });
  it("rejects a new master-key generation", async () => {
    vi.stubEnv("CERNERE_AUTH_SESSION_KEY_ID", "key-2");
    await expect(assertUserSessionCurrent(claims, reader)).rejects.toMatchObject({ statusCode: 401 });
  });
  it("never upgrades a restored token to fresh authentication", async () => {
    claims.authentication = { ...authentication, authTime: 200, authTimeMs: 200_000 };
    await expect(assertUserSessionCurrent(claims, reader)).rejects.toMatchObject({ statusCode: 401 });
  });
  it("rejects pre-migration device records without authentication evidence", async () => {
    device!.authentication = null;
    await expect(assertUserSessionCurrent(claims, reader)).rejects.toMatchObject({ statusCode: 401 });
  });
  it("cannot use a legacy user token after global revocation", async () => {
    await expect(assertUserSessionCurrent({ sub: userId, role: "general" }, reader)).rejects.toMatchObject({ statusCode: 401 });
  });
});
