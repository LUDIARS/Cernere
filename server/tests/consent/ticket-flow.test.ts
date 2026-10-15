/**
 * /consent の判断 (decideConsentTicket) — 判断の権限 (Origin / 本人セッション)、継続先は ticket の中の
 * 値だけ、使い切り、拒否で consent_denied。DB / Redis / authCode 発行はモックする。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsentTicket } from "../../src/consent/ticket.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TICKET = "a".repeat(43);

const state = vi.hoisted(() => ({
  ticket: null as unknown,
  saved: [] as unknown[],
  denials: [] as unknown[],
  synced: [] as unknown[],
  issued: [] as unknown[],
}));

vi.mock("../../src/consent/ticket.js", () => ({
  getConsentTicket: async () => state.ticket,
  consumeConsentTicket: async () => { const t = state.ticket; state.ticket = null; return t; },
}));
vi.mock("../../src/consent/project-resolver.js", () => ({
  resolveConsentSubject: async () => ({
    subject: { kind: "project", key: "svc" }, name: "Service", mode: "enforce",
    declaration: { version: 1, permissions: [
      { key: "profile.email", level: "recommended", purpose: "通知", visible_to: ["self"] },
    ] },
    caps: { profileFields: ["email"], identityClaims: [], userDataModules: [], oidcScopes: [] },
    sharing: [], frontendOrigin: "https://svc.example.com",
  }),
}));
vi.mock("../../src/consent/store.js", () => ({
  getConsentRecord: async () => null,
  saveConsent: async (...args: unknown[]) => { state.saved.push(args); },
  recordDenial: async (...args: unknown[]) => { state.denials.push(args); },
}));
vi.mock("../../src/consent/denial-sync.js", () => ({
  applyConsentDenials: async (...args: unknown[]) => { state.synced.push(args); },
}));
vi.mock("../../src/auth/auth-code.js", () => ({
  issueAuthCode: async (user: unknown) => { state.issued.push(user); return "auth-code-1"; },
}));
vi.mock("../../src/project/service.js", () => ({ ensureUserProjectRow: async () => undefined }));
vi.mock("../../src/logging/auth-logger.js", () => ({ logAuthEvent: () => undefined }));
vi.mock("../../src/auth/composite-redirect.js", () => ({ compositeAllowedOrigins: () => [] }));

const { decideConsentTicket, describeConsentTicket } = await import("../../src/consent/ticket-flow.js");

function ticket(partial: Partial<ConsentTicket> = {}): ConsentTicket {
  return {
    authUser: { userId: USER, displayName: "Neco", email: null, role: "general" },
    subject: { kind: "project", key: "svc" },
    continuation: { kind: "redirect", url: "https://svc.example.com/after" },
    channel: "browser",
    declarationVersion: 1,
    deliverAuthCode: true,
    createdAt: Date.now(),
    ...partial,
  };
}

beforeEach(() => {
  state.ticket = ticket();
  state.saved = [];
  state.denials = [];
  state.synced = [];
  state.issued = [];
});

describe("decideConsentTicket", () => {
  it("許可: 必須 + 選んだ推奨を保存し、ticket の継続先へ authCode を載せる", async () => {
    const outcome = await decideConsentTicket(TICKET, { decision: "grant", recommended: ["profile.email"] },
      { fromCernereFrontend: true });
    expect(outcome).toEqual({ kind: "redirect", url: "https://svc.example.com/after?code=auth-code-1" });
    expect(state.saved).toEqual([[USER, { kind: "project", key: "svc" }, "grant",
      { version: 1, granted: ["identity.basic", "profile.email"], denied: [] }]]);
    expect(state.issued).toEqual([expect.objectContaining({
      userId: USER, service: { subject: { projectKey: "svc" }, channel: "browser" },
    })]);
  });

  it("推奨を外して許可すると拒否として反映する (§5.3)", async () => {
    await decideConsentTicket(TICKET, { decision: "grant", recommended: [] }, { fromCernereFrontend: true });
    expect(state.synced).toEqual([[USER, { kind: "project", key: "svc" },
      { granted: ["identity.basic"], denied: ["profile.email"] }]]);
  });

  it("拒否: 同意を保存せずログインを中止し、サービスへ consent_denied を返す", async () => {
    const outcome = await decideConsentTicket(TICKET, { decision: "deny", recommended: [] }, { fromCernereFrontend: true });
    expect(outcome).toEqual({ kind: "redirect", url: "https://svc.example.com/after?error=consent_denied" });
    expect(state.saved).toEqual([]);
    expect(state.issued).toEqual([]);
    expect(state.denials).toHaveLength(1);
  });

  it("ticket は使い切り (二重の判断で authCode を 2 つ出さない)", async () => {
    await decideConsentTicket(TICKET, { decision: "grant", recommended: [] }, { fromCernereFrontend: true });
    await expect(decideConsentTicket(TICKET, { decision: "grant", recommended: [] }, { fromCernereFrontend: true }))
      .rejects.toMatchObject({ code: "consent_ticket_expired" });
    expect(state.issued).toHaveLength(1);
  });

  it("サービス経由の ticket は本人の Cernere セッションが無いと判断できない (代理同意の禁止)", async () => {
    state.ticket = ticket({ channel: "service" });
    await expect(decideConsentTicket(TICKET, { decision: "grant", recommended: [] }, { fromCernereFrontend: true }))
      .rejects.toMatchObject({ statusCode: 401, code: "consent_session_required" });
    await expect(decideConsentTicket(TICKET, { decision: "grant", recommended: [] }, { userId: USER, fromCernereFrontend: false }))
      .resolves.toMatchObject({ kind: "redirect" });
  });

  it("ブラウザの ticket も Cernere の画面以外 (Origin) からは判断できない", async () => {
    await expect(decideConsentTicket(TICKET, { decision: "grant", recommended: [] }, { fromCernereFrontend: false }))
      .rejects.toMatchObject({ code: "consent_session_required" });
    expect(state.issued).toEqual([]);
  });

  it("別のユーザーのセッションでは判断できない", async () => {
    await expect(describeConsentTicket(TICKET, { userId: OTHER, fromCernereFrontend: true }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it("edge (deliverAuthCode=false) と継続先の無い ticket は authCode を作らない", async () => {
    state.ticket = ticket({ deliverAuthCode: false, continuation: { kind: "redirect", url: "https://hub.example.com/" } });
    await expect(decideConsentTicket(TICKET, { decision: "grant", recommended: [] }, { fromCernereFrontend: true }))
      .resolves.toEqual({ kind: "redirect", url: "https://hub.example.com/" });
    state.ticket = ticket({ continuation: null });
    await expect(decideConsentTicket(TICKET, { decision: "grant", recommended: [] }, { fromCernereFrontend: true }))
      .resolves.toEqual({ kind: "none" });
    expect(state.issued).toEqual([]);
  });
});
