/**
 * approve → token → userinfo の各段で、 セッション由来 (authEpoch / role / MFA 世代) と
 * 企業接続ポリシーの **両方** が再評価されることを固定する。
 *
 * この経路は端末セッション側 (authEpoch) と企業 SSO 側 (Cloudflare 接続) が
 * 別々に硬化させた箇所が重なっており、 片方だけ残す解決をすると
 * 「失効済みセッションでも code が交換できる」/「接続が変わっても token が出る」 の
 * どちらかが静かに復活する。 そのため両方を 1 本の経路として検証する。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import { completedAuthentication } from "../../src/lib/authentication-evidence.js";

const USER = "11111111-1111-4111-8111-111111111111";
const CLIENT = "enterprise-client";

const state = vi.hoisted(() => ({
  authEpoch: 0, revision: 3, role: "general",
  connected: true, memberRole: "member", connectionRevision: "connection-revision-1",
}));
const store = vi.hoisted(() => ({ values: new Map<string, string>() }));

vi.mock("../../src/redis.js", () => ({
  redis: {
    async set(key: string, value: string) { store.values.set(key, value); },
    async get(key: string) { return store.values.get(key) ?? null; },
    async getdel(key: string) { const v = store.values.get(key) ?? null; store.values.delete(key); return v; },
    async del(key: string) { store.values.delete(key); },
  },
  checkRateLimit: async () => {},
}));

// 投影は無視して 1 行を返す。 currentUserSessionState / checkOidcAuthentication /
// loadClaimUser がそれぞれ別のキーを読むので、 行は全部のキーを同時に持たせる。
vi.mock("../../src/db/connection.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({
      limit: async () => [{
        id: USER, sub: USER, role: state.role,
        authEpoch: state.authEpoch, mfaRevision: state.revision, revision: state.revision,
        email: "user@example.com", displayName: "User", login: "user", avatarUrl: null,
        googleId: "google-user", githubId: null,
      }],
    }) }) }),
  },
}));

vi.mock("../../src/oidc/clients.js", () => ({
  getClientByClientId: async (clientId: string) => ({ clientId, name: "Enterprise App", isActive: true }),
  isRedirectUriAllowed: () => true,
  verifyClientSecret: async () => true,
  touchLastUsed: async () => {},
}));

vi.mock("../../src/enterprise/connections.js", () => ({
  connectionForClient: async () => state.connected ? { projectKey: "demo" } : null,
  requireConnection: async () => ({
    projectKey: "demo", organizationId: "00000000-0000-4000-8000-000000000001",
    revision: state.connectionRevision, requireMfa: true, maxAuthenticationAge: 600, maxSessionSeconds: 600,
  }),
  requireMembership: async () => ({
    role: state.memberRole, joinedAt: "2020-01-01T00:00:00.000Z", authenticationRevision: state.revision,
  }),
}));

const { approveAuthorization, exchangeToken, userinfo } = await import("../../src/oidc/provider.js");
const { putAuthRequest } = await import("../../src/oidc/store.js");

const evidence = () => completedAuthentication("totp", state.revision, Date.now() - 1000);
const claims = () => ({
  tokenType: "user_access" as const, sub: USER, role: state.role, iat: 0,
  exp: Math.floor(Date.now() / 1000) + 600,
  authEpoch: state.authEpoch, mfaRevision: state.revision, authentication: evidence(),
});

async function approve() {
  const requestId = await putAuthRequest({
    createdAtMs: Date.now() - 100, forceReauth: false,
    clientId: CLIENT, redirectUri: "https://app.example.com/cb", scope: ["openid", "email"],
  });
  const c = claims();
  const { redirectTo } = await approveAuthorization(requestId, c.sub, c.authentication, c);
  return new URL(redirectTo).searchParams.get("code") ?? "";
}

const exchange = (code: string) => exchangeToken({
  grantType: "authorization_code", code, redirectUri: "https://app.example.com/cb",
  clientId: CLIENT, clientSecret: "secret",
});

beforeEach(() => {
  store.values.clear();
  Object.assign(state, {
    authEpoch: 0, revision: 3, role: "general",
    connected: true, memberRole: "member", connectionRevision: "connection-revision-1",
  });
});

describe("OIDC authorization provenance and enterprise policy", () => {
  it("carries the approving session's verified facts into the id_token as a single source", async () => {
    const issued = await exchange(await approve());
    const idToken = jwt.decode(issued.id_token) as Record<string, unknown>;
    expect(idToken.amr).toEqual(["pwd", "otp", "mfa"]);
    expect(idToken.cr_auth_revision).toBe(3);
    expect(typeof idToken.auth_time).toBe("number");
    expect(idToken.cr_project).toBe("demo");
    expect(idToken.cr_user_id).toBe(USER);
  });

  it("stores the evidence only under the authorization record", async () => {
    await approve();
    const code = [...store.values.entries()].find(([k]) => k.startsWith("oidc:code:"))![1];
    const record = JSON.parse(code) as Record<string, unknown>;
    // 二重保管すると片方だけ失効判定に使われる事故が起きる。 正本は authorization のみ。
    expect(record.authentication).toBeUndefined();
    expect((record.authorization as { authentication?: unknown }).authentication).toBeDefined();
    expect(record.enterprise).toBeDefined();
  });

  it("rejects an authorization code whose user session was globally revoked", async () => {
    const code = await approve();
    state.authEpoch = 1; // 端末セッション一括失効
    await expect(exchange(code)).rejects.toThrow("Authorizing session was revoked");
  });

  it("rejects an authorization code after the organization role changed", async () => {
    const code = await approve();
    state.memberRole = "admin";
    await expect(exchange(code)).rejects.toThrow("authentication expired or authorization changed");
  });

  it("rejects an authorization code after the enterprise connection was removed", async () => {
    const code = await approve();
    state.connected = false;
    await expect(exchange(code)).rejects.toThrow("authentication expired or authorization changed");
  });

  it("re-checks both the session and the connection on every userinfo call", async () => {
    const issued = await exchange(await approve());
    expect((await userinfo(issued.access_token)).sub).toBe(USER);

    state.authEpoch = 1;
    await expect(userinfo(issued.access_token)).rejects.toThrow(/revoked|session/i);

    state.authEpoch = 0;
    state.connectionRevision = "connection-revision-2";
    await expect(userinfo(issued.access_token)).rejects.toThrow(/changed|authorization/i);
  });

  it("refuses to approve when the login session that carried the evidence has expired", async () => {
    const requestId = await putAuthRequest({
      createdAtMs: Date.now() - 100, forceReauth: false,
      clientId: CLIENT, redirectUri: "https://app.example.com/cb", scope: ["openid"],
    });
    const expired = { ...claims(), exp: Math.floor(Date.now() / 1000) - 1 };
    await expect(approveAuthorization(requestId, expired.sub, expired.authentication, expired))
      .rejects.toThrow(/expired/i);
  });
});
