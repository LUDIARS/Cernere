/**
 * issueAuthCode の関門: サービス向けは対象サービスが必須で、requireActiveUser の直後に同意を判定し、
 * consent_required なら refresh 行も authCode も作らない。Cernere 自身 (audience = cernere) は判定しない。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ order: [] as string[], gate: [] as unknown[], block: false }));

vi.mock("../../src/auth/user-access.js", () => ({
  requireActiveUser: async () => { calls.order.push("active"); },
}));
vi.mock("../../src/consent/gate.js", () => ({
  enforceServiceConsent: async (_user: unknown, request: unknown) => {
    calls.order.push("consent");
    calls.gate.push(request);
    if (calls.block) throw Object.assign(new Error("consent required"), { code: "consent_required" });
  },
}));
vi.mock("../../src/auth/jwt.js", () => ({
  generateTokenPair: async () => { calls.order.push("tokens"); return { accessToken: "a", refreshToken: "r", authEpoch: 0 }; },
  REFRESH_TOKEN_DAYS: 30,
}));
vi.mock("../../src/db/connection.js", () => ({
  db: { insert: () => ({ values: async () => { calls.order.push("refresh-row"); } }) },
}));
vi.mock("../../src/redis.js", () => ({
  redis: { set: async () => { calls.order.push("authcode"); } },
}));

const { issueAuthCode } = await import("../../src/auth/auth-code.js");

const user = { userId: "11111111-1111-4111-8111-111111111111", displayName: "Neco", email: null, role: "general" };

beforeEach(() => {
  calls.order = [];
  calls.gate = [];
  calls.block = false;
});

describe("issueAuthCode — 同意の関門", () => {
  it("サービス向けは対象サービスを渡さないと発行しない", async () => {
    await expect(issueAuthCode(user)).rejects.toThrow(/service target is required/);
    expect(calls.order).not.toContain("authcode");
  });

  it("requireActiveUser の直後に同意を判定し、通れば発行する", async () => {
    await issueAuthCode({ ...user, service: { subject: { projectKey: "svc" }, channel: "browser" } });
    expect(calls.order).toEqual(["active", "consent", "tokens", "refresh-row", "authcode"]);
    expect(calls.gate).toEqual([{ subject: { projectKey: "svc" }, channel: "browser" }]);
  });

  it("同意が要るときは refresh 行も authCode も作らない", async () => {
    calls.block = true;
    await expect(issueAuthCode({ ...user, service: { subject: { projectKey: "svc" }, channel: "browser" } }))
      .rejects.toMatchObject({ code: "consent_required" });
    expect(calls.order).toEqual(["active", "consent"]);
  });

  it("Cernere 自身 (audience = cernere) は判定しない", async () => {
    await issueAuthCode({ ...user, audience: "cernere" });
    expect(calls.order).toEqual(["tokens", "refresh-row", "authcode"]);
  });
});
