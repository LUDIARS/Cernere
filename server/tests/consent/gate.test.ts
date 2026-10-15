/**
 * 同意の関門 (enforceServiceConsent) — consent_mode off / warn / enforce の振る舞いと、
 * consentTicket に入る継続先が検証済みの値だけであること。DB / Redis はモックする。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConsentSubject } from "../../src/consent/project-resolver.js";

const resolver = vi.hoisted(() => ({ project: null as unknown, byOrigin: null as unknown }));
const records = vi.hoisted(() => ({ value: null as unknown, calls: 0 }));
const tickets = vi.hoisted(() => ({ created: [] as unknown[] }));
const events = vi.hoisted(() => ({ logged: [] as Array<{ event: string }> }));
const signup = vi.hoisted(() => ({ missingRequired: [] as string[], calls: 0 }));

vi.mock("../../src/consent/project-resolver.js", () => ({
  resolveProjectSubject: async () => resolver.project,
  resolveSubjectByOrigin: async () => resolver.byOrigin,
}));
vi.mock("../../src/consent/store.js", () => ({
  getConsentRecord: async () => { records.calls += 1; return records.value; },
}));
vi.mock("../../src/consent/ticket.js", () => ({
  createConsentTicket: async (record: unknown) => { tickets.created.push(record); return "t".repeat(43); },
}));
vi.mock("../../src/logging/auth-logger.js", () => ({
  logAuthEvent: (event: { event: string }) => { events.logged.push(event); },
}));
vi.mock("../../src/auth/composite-redirect.js", () => ({
  compositeAllowedOrigins: () => ["https://popup-host.example.com"],
}));
vi.mock("../../src/signup-fields/evaluate.js", () => ({
  evaluateSignupFieldsForUser: async () => { signup.calls += 1; return { missingRequired: signup.missingRequired }; },
}));
vi.mock("../../src/config.js", () => ({ config: { frontendUrl: "https://cernere.example.com/" } }));

const { enforceServiceConsent, ConsentRequiredError } = await import("../../src/consent/gate.js");

const user = { userId: "11111111-1111-4111-8111-111111111111", displayName: "Neco", email: null, role: "general" };

function subject(mode: "off" | "warn" | "enforce"): ResolvedConsentSubject {
  return {
    subject: { kind: "project", key: "svc" },
    name: "Service",
    mode,
    declaration: { version: 2, permissions: [
      { key: "profile.email", level: "recommended", purpose: "通知", visible_to: ["self"] },
    ] },
    caps: { profileFields: ["email"], identityClaims: [], userDataModules: [], oidcScopes: [] },
    sharing: [],
    frontendOrigin: "https://svc.example.com",
  };
}

const satisfiedRecord = { declarationVersion: 2, granted: ["identity.basic"], denied: ["profile.email"], revoked: false };

beforeEach(() => {
  resolver.project = null;
  resolver.byOrigin = null;
  records.value = null;
  records.calls = 0;
  tickets.created = [];
  events.logged = [];
  signup.missingRequired = [];
  signup.calls = 0;
});

describe("enforceServiceConsent", () => {
  it("off (既定) は判定しない — 同意を読まずに通す (既存サービスのログインは変わらない)", async () => {
    resolver.project = subject("off");
    await expect(enforceServiceConsent(user, { subject: { projectKey: "svc" }, channel: "browser" })).resolves.toBeUndefined();
    expect(records.calls).toBe(0);
    expect(tickets.created).toEqual([]);
  });

  it("対象サービスを特定できない経路は通す (ログだけ)", async () => {
    await expect(enforceServiceConsent(user, { subject: null, channel: "browser", reason: "test" })).resolves.toBeUndefined();
    await expect(enforceServiceConsent(user, { subject: { origin: "https://unknown.example.com" }, channel: "browser" })).resolves.toBeUndefined();
  });

  it("warn は未充足でも通し、consent.would_block を記録する", async () => {
    resolver.project = subject("warn");
    await expect(enforceServiceConsent(user, { subject: { projectKey: "svc" }, channel: "browser" })).resolves.toBeUndefined();
    expect(events.logged.map((e) => e.event)).toEqual(["consent.would_block"]);
    expect(tickets.created).toEqual([]);
  });

  it("enforce で充足していれば通す", async () => {
    resolver.project = subject("enforce");
    records.value = satisfiedRecord;
    await expect(enforceServiceConsent(user, { subject: { projectKey: "svc" }, channel: "browser" })).resolves.toBeUndefined();
    expect(tickets.created).toEqual([]);
  });

  it("enforce で未充足なら authCode を出さず consentTicket と /consent の URL を返す", async () => {
    resolver.project = subject("enforce");
    const error = await enforceServiceConsent(user, {
      subject: { projectKey: "svc" },
      continuation: { mode: "redirect", target: "https://svc.example.com/after" },
      channel: "browser",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConsentRequiredError);
    expect((error as InstanceType<typeof ConsentRequiredError>).consentUrl)
      .toBe(`https://cernere.example.com/consent?ticket=${"t".repeat(43)}`);
    expect(tickets.created).toEqual([expect.objectContaining({
      subject: { kind: "project", key: "svc" },
      continuation: { kind: "redirect", url: "https://svc.example.com/after" },
      channel: "browser",
      declarationVersion: 2,
      deliverAuthCode: true,
    })]);
  });

  it("許可外の送り先は ticket の継続先に入れない (open redirect 防止)", async () => {
    resolver.byOrigin = subject("enforce");
    await enforceServiceConsent(user, {
      subject: { origin: "https://evil.example.com" },
      continuation: { mode: "redirect", target: "https://evil.example.com/steal" },
      channel: "browser",
    }).catch(() => undefined);
    expect(tickets.created).toEqual([expect.objectContaining({ continuation: null })]);
  });

  it("composite 許可 origin の popup は postMessage の継続先になる", async () => {
    resolver.byOrigin = subject("enforce");
    await enforceServiceConsent(user, {
      subject: { origin: "https://popup-host.example.com" },
      continuation: { mode: "post_message", target: "https://popup-host.example.com" },
      channel: "browser",
    }).catch(() => undefined);
    expect(tickets.created).toEqual([expect.objectContaining({
      continuation: { kind: "post_message", origin: "https://popup-host.example.com" },
    })]);
  });

  it("サービス経由で送り先の指定が無ければサービスの frontend_url へ戻す (edge は redirect)", async () => {
    resolver.project = subject("enforce");
    await enforceServiceConsent(user, { subject: { projectKey: "svc" }, channel: "service" }).catch(() => undefined);
    await enforceServiceConsent(user, {
      subject: { projectKey: "svc" }, channel: "service", deliverAuthCode: false, defaultContinuation: "redirect",
    }).catch(() => undefined);
    expect(tickets.created).toEqual([
      expect.objectContaining({ continuation: { kind: "post_message", origin: "https://svc.example.com" }, channel: "service" }),
      expect.objectContaining({ continuation: { kind: "redirect", url: "https://svc.example.com/" }, deliverAuthCode: false }),
    ]);
  });
});

describe("enforceServiceConsent — 入力項目 (signup_fields)", () => {
  const declared = (mode: "off" | "warn" | "enforce"): ResolvedConsentSubject => ({
    ...subject(mode),
    signupFields: { version: 1, fields: [{ column: "affiliation", label: "所属", required: true, input: "text" }] },
  });

  it("宣言の無いサービスは入力を見ずに素通り", async () => {
    resolver.project = subject("off");
    signup.missingRequired = ["affiliation"];
    await expect(enforceServiceConsent(user, { subject: { projectKey: "svc" }, channel: "browser" })).resolves.toBeUndefined();
    expect(signup.calls).toBe(0);
  });

  it("必須が未入力なら consent_mode=off でも authCode を出さず /consent へ (同じ consent_required)", async () => {
    resolver.project = declared("off");
    signup.missingRequired = ["affiliation"];
    const error = await enforceServiceConsent(user, { subject: { projectKey: "svc" }, channel: "browser" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConsentRequiredError);
    expect((error as InstanceType<typeof ConsentRequiredError>).code).toBe("consent_required");
    expect(tickets.created).toHaveLength(1);
    expect(events.logged.map((e) => e.event)).toEqual(["signup_fields.required"]);
  });

  it("必須の不足は warn でも止める (同意の充足に関係なく)", async () => {
    resolver.project = declared("warn");
    records.value = satisfiedRecord;
    signup.missingRequired = ["affiliation"];
    await expect(enforceServiceConsent(user, { subject: { projectKey: "svc" }, channel: "browser" }))
      .rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it("任意だけが未入力なら止めない", async () => {
    resolver.project = declared("off");
    await expect(enforceServiceConsent(user, { subject: { projectKey: "svc" }, channel: "browser" })).resolves.toBeUndefined();
    expect(signup.calls).toBe(1);
    expect(records.calls).toBe(0);
    expect(tickets.created).toEqual([]);
  });
});
