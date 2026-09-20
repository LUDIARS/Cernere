import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { completedAuthentication } from "../../src/lib/authentication-evidence.js";

const state = vi.hoisted(() => ({ configured: true, active: true, member: true, revision: 3, role: "member" }));
vi.mock("../../src/db/connection.js", () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ revision: state.revision }] }) }) }),
} }));
vi.mock("../../src/enterprise/connections.js", () => ({
  connectionForClient: async () => state.configured ? { projectKey: "demo" } : null,
  requireConnection: async () => {
    if (!state.active) throw new Error("disabled");
    return { projectKey: "demo", organizationId: "org", revision: "connection-revision", requireMfa: true,
      maxAuthenticationAge: 600, maxSessionSeconds: 300 };
  },
  requireMembership: async () => {
    if (!state.member) throw new Error("membership required");
    return { role: state.role, joinedAt: "2020-01-01T00:00:00.000Z", authenticationRevision: state.revision };
  },
}));
import { checkOidcAuthentication } from "../../src/enterprise/oidc-policy.js";

const now = 1800000000000;
const requirement = { createdAtMs: now - 100, forceReauth: false };
const evidence = () => completedAuthentication("totp", 3, now - 1000);
beforeEach(() => {
  Object.assign(state, { configured: true, active: true, member: true, revision: 3, role: "member" });
  vi.useFakeTimers(); vi.setSystemTime(now);
});
afterEach(() => { vi.useRealTimers(); });

describe("OIDC enterprise grant validation", () => {
  it("requires real MFA facts for enterprise consent", async () => {
    await expect(checkOidcAuthentication("client", "user", undefined, requirement)).rejects.toThrow();
    await expect(checkOidcAuthentication("client", "user", completedAuthentication("password", 3, now), requirement)).rejects.toThrow();
  });
  it("omits unknown legacy facts for ordinary clients instead of inventing an authentication time", async () => {
    state.configured = false;
    expect(await checkOidcAuthentication("client", "user", undefined, requirement)).toEqual({ authentication: undefined });
  });
  it("rejects a membership role change between consent and token exchange", async () => {
    const approved = await checkOidcAuthentication("client", "user", evidence(), requirement);
    state.role = "admin";
    await expect(checkOidcAuthentication("client", "user", evidence(), undefined, approved.enterprise)).rejects.toThrow();
  });
  it("rejects disabled clients' connections, removed membership and changed MFA configuration", async () => {
    state.active = false;
    await expect(checkOidcAuthentication("client", "user", evidence(), requirement)).rejects.toThrow();
    state.active = true; state.member = false;
    await expect(checkOidcAuthentication("client", "user", evidence(), requirement)).rejects.toThrow();
    state.member = true; state.revision = 4;
    await expect(checkOidcAuthentication("client", "user", evidence(), requirement)).rejects.toThrow();
  });
  it("does not extend the approved absolute deadline or upgrade a pre-connection grant", async () => {
    const approved = await checkOidcAuthentication("client", "user", evidence(), requirement);
    vi.setSystemTime(now + 10000);
    const exchanged = await checkOidcAuthentication("client", "user", evidence(), undefined, approved.enterprise);
    expect(exchanged.enterprise?.expiresAt).toBe(approved.enterprise?.expiresAt);
    await expect(checkOidcAuthentication("client", "user", evidence())).rejects.toThrow();
  });
});
