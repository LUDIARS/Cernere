/**
 * /consent の判断に入力項目を載せる (spec/plan/2026-10-15-service-signup-fields-design.md §4.1 / §7) —
 * 権限と入力値を同じトランザクションで保存し、入力の誤りでは何も保存せず ticket も使い切らない。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/federation/subject.js", async () => (await import("../federation/unfederated-subject.js")).unfederatedSubject);
import type { ConsentTicket } from "../../src/consent/ticket.js";
import { columns, consent, declaration } from "../signup-fields/fixtures.js";

const USER = "11111111-1111-4111-8111-111111111111";
const TICKET = "b".repeat(43);

const state = vi.hoisted(() => ({
  ticket: null as unknown,
  saved: [] as unknown[][],
  writes: [] as unknown[][],
  inTransaction: false,
}));

vi.mock("../../src/consent/ticket.js", () => ({
  getConsentTicket: async () => state.ticket,
  consumeConsentTicket: async () => { const t = state.ticket; state.ticket = null; return t; },
}));
vi.mock("../../src/consent/project-resolver.js", async () => {
  const fixtures = await import("../signup-fields/fixtures.js");
  return {
    resolveConsentSubject: async () => ({
      subject: { kind: "project", key: "svc" }, name: "Service", mode: "off",
      declaration: fixtures.consent,
      caps: { profileFields: [], identityClaims: [], userDataModules: ["member", "social"], oidcScopes: [] },
      sharing: [], frontendOrigin: "https://svc.example.com",
      signupFields: fixtures.declaration, userColumns: fixtures.columns, storageTable: "project_data_svc",
    }),
  };
});
vi.mock("../../src/consent/store.js", () => ({
  getConsentRecord: async () => null,
  recordDenial: async () => undefined,
  // 実装のトランザクションの代わり: 同意の保存の内側で fields.write が呼ばれることを確かめる。
  saveConsent: async (...args: unknown[]) => {
    state.saved.push(args);
    const fields = args[4] as { write?: (tx: unknown) => Promise<void> } | undefined;
    state.inTransaction = true;
    try { await fields?.write?.("tx-1"); } finally { state.inTransaction = false; }
  },
}));
vi.mock("../../src/signup-fields/store.js", () => ({
  deniedSignupModules: async () => new Set<string>(),
  loadSignupValues: async () => ({}),
  writeSignupValues: async (...args: unknown[]) => { state.writes.push([...args, state.inTransaction]); },
  // 保存先表ごとの書き込み (設計書 §8.2)。表ごとに writeSignupValues と同じ形で記録する。
  writeSignupValueGroups: async (tx: unknown, userId: string, groups: Array<{ table: string; values: unknown }>) => {
    for (const group of groups) state.writes.push([tx, group.table, userId, group.values, state.inTransaction]);
  },
}));
vi.mock("../../src/db/connection.js", () => ({ db: {} }));
vi.mock("../../src/project/user-data-cache.js", () => ({ invalidate: async () => undefined }));
vi.mock("../../src/consent/denial-sync.js", () => ({ applyConsentDenials: async () => undefined }));
vi.mock("../../src/auth/auth-code.js", () => ({ issueAuthCode: async () => "auth-code-1" }));
vi.mock("../../src/project/service.js", () => ({ ensureUserProjectRow: async () => undefined }));
vi.mock("../../src/logging/auth-logger.js", () => ({ logAuthEvent: () => undefined }));
vi.mock("../../src/auth/composite-redirect.js", () => ({ compositeAllowedOrigins: () => [] }));

const { decideConsentTicket, describeConsentTicket } = await import("../../src/consent/ticket-flow.js");
const { SignupFieldsInvalidError } = await import("../../src/signup-fields/errors.js");

function ticket(): ConsentTicket {
  return {
    authUser: { userId: USER, displayName: "Neco", email: null, role: "general" },
    subject: { kind: "project", key: "svc" },
    continuation: { kind: "redirect", url: "https://svc.example.com/after" },
    channel: "browser",
    declarationVersion: 1,
    deliverAuthCode: true,
    createdAt: Date.now(),
  };
}

const viewer = { fromCernereFrontend: true };

beforeEach(() => {
  state.ticket = ticket();
  state.saved = [];
  state.writes = [];
});

describe("decideConsentTicket — 入力項目", () => {
  it("画面に入力項目 (未入力の必須と任意) を出す", async () => {
    const described = await describeConsentTicket(TICKET, viewer);
    expect(described.signupFields?.fields.map((f) => f.column)).toEqual(["affiliation", "grade", "bio"]);
    expect(declaration.fields).toHaveLength(3);
    expect(Object.keys(columns)).toContain("affiliation");
  });

  it("権限と入力値を同じトランザクションで保存する", async () => {
    const outcome = await decideConsentTicket(TICKET, {
      decision: "grant", recommended: ["user_data.module:social"], fields: { affiliation: "ゲーム制作学科", grade: "1", bio: "よろしく" },
    }, viewer);
    expect(outcome).toEqual({ kind: "redirect", url: "https://svc.example.com/after?code=auth-code-1" });
    expect(state.saved).toHaveLength(1);
    expect(state.saved[0][4]).toMatchObject({ version: 1, seen: ["affiliation", "grade", "bio"] });
    expect(state.writes).toEqual([[
      "tx-1", "project_data_svc", USER, { affiliation: "ゲーム制作学科", grade: "1", bio: "よろしく" }, true,
    ]]);
  });

  it("同じ判断で外した推奨 module の列は書かない", async () => {
    await decideConsentTicket(TICKET, {
      decision: "grant", recommended: [], fields: { affiliation: "A", bio: "書かれない" },
    }, viewer);
    expect(state.writes).toEqual([["tx-1", "project_data_svc", USER, { affiliation: "A" }, true]]);
    expect(consent.permissions.some((p) => p.key === "user_data.module:social")).toBe(true);
  });

  it("入力の誤りは項目ごとに返し、何も保存せず ticket も使い切らない", async () => {
    const error = await decideConsentTicket(TICKET, {
      decision: "grant", recommended: [], fields: { affiliation: "", grade: "9" },
    }, viewer).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignupFieldsInvalidError);
    expect((error as InstanceType<typeof SignupFieldsInvalidError>).fieldErrors).toEqual({
      affiliation: "入力してください", grade: "選択肢から選んでください",
    });
    expect(state.saved).toEqual([]);
    expect(state.writes).toEqual([]);
    expect(state.ticket).not.toBeNull();
  });
});
