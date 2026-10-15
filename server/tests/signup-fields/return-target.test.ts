/**
 * オンボーディングの戻り先からのサービス解決 (設計書 §4.2 / §7) — Cernere 外の戻り先・未登録 origin は null。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { returnTargetOf } from "../../src/signup-fields/return-target.js";

const state = vi.hoisted(() => ({ byOrigin: new Map<string, unknown>(), targets: [] as string[] }));

vi.mock("../../src/consent/project-resolver.js", () => ({
  resolveSubjectByOrigin: async (target: string) => { state.targets.push(target); return state.byOrigin.get(target) ?? null; },
  resolveProjectSubject: async () => null,
}));
vi.mock("../../src/consent/store.js", () => ({ getConsentRecord: async () => null }));
vi.mock("../../src/signup-fields/evaluate.js", () => ({
  evaluateSignupFieldsForUser: async () => ({ version: 1, fields: [], missingRequired: ["affiliation"] }),
}));
vi.mock("../../src/signup-fields/submission.js", () => ({ saveSignupFields: async () => undefined }));
vi.mock("../../src/logging/auth-logger.js", () => ({ logAuthEvent: () => undefined }));

const { signupFieldsCommand } = await import("../../src/signup-fields/command.js");
const USER = "11111111-1111-4111-8111-111111111111";
const BACKSLASH = String.fromCharCode(92);

beforeEach(() => {
  state.byOrigin = new Map();
  state.targets = [];
});

describe("returnTargetOf", () => {
  it("/composite/login の origin と redirect_uri を取り出す", () => {
    expect(returnTargetOf("/composite/login?origin=https%3A%2F%2Fglab.example.com&mode=popup")).toBe("https://glab.example.com");
    expect(returnTargetOf("/oidc/authorize?client_id=x&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb")).toBe("https://app.example.com/cb");
  });

  it("Cernere 外の戻り先・プロトコル相対・手がかりの無いパスは null", () => {
    expect(returnTargetOf("https://evil.example.com/composite/login?origin=https://glab.example.com")).toBeNull();
    expect(returnTargetOf("//evil.example.com/composite/login?origin=https://glab.example.com")).toBeNull();
    expect(returnTargetOf(`/${BACKSLASH}evil.example.com/?redirect_uri=https://glab.example.com`)).toBeNull();
    expect(returnTargetOf("/")).toBeNull();
    expect(returnTargetOf("/profile?origin=https://glab.example.com")).toBeNull();
    expect(returnTargetOf(42)).toBeNull();
  });
});

describe("signup_fields.for_return", () => {
  it("Cernere 外の戻り先は解決を試みず null", async () => {
    await expect(signupFieldsCommand(USER, "for_return", { returnTo: "https://evil.example.com/" })).resolves.toBeNull();
    expect(state.targets).toEqual([]);
  });

  it("未登録 origin・入力項目を宣言していないサービスは null", async () => {
    await expect(signupFieldsCommand(USER, "for_return", { returnTo: "/composite/login?origin=https://unknown.example.com" }))
      .resolves.toBeNull();
    state.byOrigin.set("https://plain.example.com", { subject: { kind: "project", key: "plain" }, name: "Plain", signupFields: null });
    await expect(signupFieldsCommand(USER, "for_return", { returnTo: "/composite/login?origin=https://plain.example.com" }))
      .resolves.toBeNull();
  });

  it("宣言したサービスは名前と聞く項目を返す", async () => {
    state.byOrigin.set("https://glab.example.com", {
      subject: { kind: "project", key: "glab" }, name: "GLAB", signupFields: { version: 1, fields: [] },
    });
    await expect(signupFieldsCommand(USER, "for_return", { returnTo: "/composite/login?origin=https://glab.example.com" }))
      .resolves.toEqual({ projectKey: "glab", serviceName: "GLAB", version: 1, fields: [], missingRequired: ["affiliation"] });
  });
});
