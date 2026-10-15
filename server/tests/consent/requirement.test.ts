import { describe, expect, it } from "vitest";
import { evaluateConsentRequirement, resolveDecision, type ConsentRecordState } from "../../src/consent/requirement.js";
import type { ConsentDeclaration } from "../../src/consent/declaration-schema.js";
import type { ConsentCaps } from "../../src/consent/permission-keys.js";

const caps: ConsentCaps = {
  profileFields: ["displayName", "email", "bio"],
  identityClaims: [],
  userDataModules: ["calendar"],
  oidcScopes: [],
};

const declarationV1: ConsentDeclaration = {
  version: 1,
  permissions: [
    { key: "profile.displayName", level: "required", purpose: "メンバー一覧に名前を出すため", visible_to: ["service_users"] },
    { key: "profile.email", level: "recommended", purpose: "締切のお知らせ", visible_to: ["self"] },
  ],
};

function record(partial: Partial<ConsentRecordState>): ConsentRecordState {
  return { declarationVersion: 1, granted: [], denied: [], revoked: false, ...partial };
}

describe("evaluateConsentRequirement", () => {
  it("同意が無ければ必須は不足・推奨は未判断。identity.basic は必ず必須", () => {
    const r = evaluateConsentRequirement({ declaration: declarationV1, caps, sharing: [], record: null });
    expect(r.satisfied).toBe(false);
    expect(r.missingRequired).toEqual(["identity.basic", "profile.displayName"]);
    expect(r.pendingRecommended).toEqual(["profile.email"]);
    expect(r.view.reconsent).toBe(false);
  });

  it("必須を許可し推奨を拒否していれば充足 (推奨は外して進める)", () => {
    const r = evaluateConsentRequirement({
      declaration: declarationV1, caps, sharing: [],
      record: record({ granted: ["identity.basic", "profile.displayName"], denied: ["profile.email"] }),
    });
    expect(r.satisfied).toBe(true);
    expect(r.view.recommended[0].decision).toBe("denied");
  });

  it("版が上がり未判断の権限が増えたときだけ再確認し、増えた権限を強調する", () => {
    const v2: ConsentDeclaration = { version: 2, permissions: [
      ...declarationV1.permissions,
      { key: "user_data.module:calendar", level: "recommended", purpose: "同期", visible_to: ["self"] },
    ] };
    const r = evaluateConsentRequirement({
      declaration: v2, caps, sharing: [],
      record: record({ granted: ["identity.basic", "profile.displayName", "profile.email"] }),
    });
    expect(r.satisfied).toBe(false);
    expect(r.view.reconsent).toBe(true);
    expect(r.pendingRecommended).toEqual(["user_data.module:calendar"]);
    expect(r.view.recommended.find((p) => p.key === "user_data.module:calendar")?.isNew).toBe(true);
    expect(r.view.recommended.find((p) => p.key === "profile.email")?.isNew).toBe(false);
  });

  it("文言だけの変更 (版据え置き) では再確認しない", () => {
    const reworded: ConsentDeclaration = { version: 1, permissions: declarationV1.permissions.map((p) => ({ ...p, purpose: "言い換え" })) };
    const r = evaluateConsentRequirement({
      declaration: reworded, caps, sharing: [],
      record: record({ granted: ["identity.basic", "profile.displayName"], denied: ["profile.email"] }),
    });
    expect(r.satisfied).toBe(true);
  });

  it("推奨で拒否した権限が必須に上がったら聞き直す", () => {
    const promoted: ConsentDeclaration = { version: 2, permissions: declarationV1.permissions.map((p) => ({ ...p, level: "required" as const })) };
    const r = evaluateConsentRequirement({
      declaration: promoted, caps, sharing: [],
      record: record({ granted: ["identity.basic", "profile.displayName"], denied: ["profile.email"] }),
    });
    expect(r.missingRequired).toEqual(["profile.email"]);
  });

  it("必須から推奨へ下がった権限は許可を保つ", () => {
    const demoted: ConsentDeclaration = { version: 2, permissions: declarationV1.permissions.map((p) => ({ ...p, level: "recommended" as const })) };
    const r = evaluateConsentRequirement({
      declaration: demoted, caps, sharing: [],
      record: record({ granted: ["identity.basic", "profile.displayName"], denied: ["profile.email"] }),
    });
    expect(r.satisfied).toBe(true);
    expect(r.view.recommended.find((p) => p.key === "profile.displayName")?.decision).toBe("granted");
  });

  it("未宣言サービスは identity.basic だけ必須、上限の残りは全て推奨で表示する (§3.3)", () => {
    const r = evaluateConsentRequirement({ declaration: null, caps, sharing: [], record: null });
    expect(r.view.declared).toBe(false);
    expect(r.view.required.map((p) => p.key)).toEqual(["identity.basic"]);
    expect(r.view.recommended.map((p) => p.key)).toEqual([
      "profile.displayName", "profile.email", "profile.bio", "user_data.module:calendar",
    ]);
    expect(r.view.recommended.every((p) => p.purpose === null)).toBe(true);
  });

  it("data_sharing の共有先を other_services (Cernere の確定情報) として足し、目立つ印を付ける", () => {
    const r = evaluateConsentRequirement({
      declaration: { version: 1, permissions: [
        { key: "user_data.module:calendar", level: "recommended", purpose: "同期", visible_to: ["self"] },
      ] },
      caps,
      sharing: [{ projectKey: "actio", name: "Actio", modules: ["calendar"] }, { projectKey: "x", name: "X", modules: ["other"] }],
      record: null,
    });
    const calendar = r.view.recommended[0];
    expect(calendar.visibleTo).toEqual([
      { audience: "self", source: "service" },
      { audience: "other_services", source: "cernere", services: ["Actio"] },
    ]);
    expect(calendar.sharedBeyondSelf).toBe(true);
  });

  it("公開設定に左右されるプロフィール項目には注記を付ける", () => {
    const r = evaluateConsentRequirement({ declaration: null, caps, sharing: [], record: null });
    expect(r.view.recommended.find((p) => p.key === "profile.bio")?.privacyDependent).toBe(true);
    expect(r.view.recommended.find((p) => p.key === "profile.email")?.privacyDependent).toBe(false);
  });

  it("上限を狭められた権限は表示しない (渡せないため)", () => {
    const r = evaluateConsentRequirement({ declaration: declarationV1, caps: { ...caps, profileFields: ["displayName"] }, sharing: [], record: null });
    expect(r.view.recommended).toEqual([]);
  });

  it("取り消した同意は無いものとして扱う", () => {
    const r = evaluateConsentRequirement({
      declaration: declarationV1, caps, sharing: [],
      record: record({ granted: ["identity.basic", "profile.displayName", "profile.email"], revoked: true }),
    });
    expect(r.satisfied).toBe(false);
  });
});

describe("resolveDecision", () => {
  it("必須は全て許可、推奨は選んだものだけ。選択肢に無いキーは無視する", () => {
    const r = evaluateConsentRequirement({ declaration: declarationV1, caps, sharing: [], record: null });
    expect(resolveDecision(r, ["profile.email", "profile.avatarUrl", "identity_claim.discord_id"])).toEqual({
      granted: ["identity.basic", "profile.displayName", "profile.email"],
      denied: [],
    });
    expect(resolveDecision(r, [])).toEqual({
      granted: ["identity.basic", "profile.displayName"],
      denied: ["profile.email"],
    });
  });
});
