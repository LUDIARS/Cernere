import { beforeEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ order: [] as string[], gate: [] as unknown[], block: false, revoked: false, stored: [] as string[] }));
vi.mock("../../src/federation/subject.js", () => ({ requireServiceAccess: async () => { calls.order.push("active"); } }));
vi.mock("../../src/auth/user-session-state.js", () => ({
  currentUserSessionState: async () => ({ sub: "account", role: "general", authEpoch: 2, mfaRevision: 1 }),
  assertUserSessionCurrent: async () => { calls.order.push("current"); if (calls.revoked) throw new Error("revoked"); },
}));
vi.mock("../../src/auth/composite-redirect.js", () => ({ projectCompositeTarget: async () => { calls.order.push("project-origin"); } }));
vi.mock("../../src/consent/gate.js", () => ({ enforceServiceConsent: async (_user: unknown, request: unknown) => {
  calls.order.push("consent"); calls.gate.push(request);
  if (calls.block) throw Object.assign(new Error("consent required"), { code: "consent_required" });
} }));
vi.mock("../../src/db/connection.js", () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ clientId: "client" }] }) }) }) } }));
vi.mock("../../src/redis.js", () => ({ redis: {
  set: async (_key: string, value: string) => { calls.order.push("authcode"); calls.stored.push(value); }, getdel: async () => null,
} }));
const { issueAuthCode } = await import("../../src/auth/auth-code.js");
const user = { userId: "account", displayName: "Neco", email: null, role: "general", authEpoch: 2 };
const binding = { audience: "service" as const, projectKey: "svc", origin: "https://svc.example", codeChallenge: "c".repeat(43) };
const service = { subject: { projectKey: "svc" }, channel: "browser" as const };
beforeEach(() => { calls.order = []; calls.gate = []; calls.block = false; calls.revoked = false; calls.stored = []; });

describe("authorization code issuance gate", () => {
  it("rejects any old request without a binding", async () => {
    await expect(issueAuthCode({ ...user, service })).rejects.toThrow(/binding is required/);
    expect(calls.stored).toEqual([]);
  });
  it("checks current subject, active user, registered project origin and consent before storing", async () => {
    await issueAuthCode({ ...user, binding, service });
    expect(calls.order).toEqual(["current", "active", "project-origin", "consent", "authcode"]);
    expect(calls.gate).toEqual([{ ...service, authCodeBinding: binding, requireConsent: true }]);
    expect(JSON.parse(calls.stored[0]!).subject).toMatchObject({ sub: "account", authEpoch: 2 });
    expect(calls.stored[0]).not.toMatch(/accessToken|refreshToken/);
  });
  it("does not create credentials or a code before consent", async () => {
    calls.block = true;
    await expect(issueAuthCode({ ...user, binding, service })).rejects.toMatchObject({ code: "consent_required" });
    expect(calls.stored).toEqual([]);
  });
  it("rejects a revoked source before any service-side work", async () => {
    calls.revoked = true;
    await expect(issueAuthCode({ ...user, binding, service })).rejects.toThrow("revoked");
    expect(calls.order).toEqual(["current"]);
  });
  it("self login still checks revocation but does not run service consent", async () => {
    await issueAuthCode({ ...user, binding: { audience: "cernere", origin: "https://cr.example", codeChallenge: "c".repeat(43) } });
    expect(calls.order).toEqual(["current", "authcode"]);
  });
});
