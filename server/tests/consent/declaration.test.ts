import { describe, expect, it } from "vitest";
import { validateConsentDeclaration } from "../../src/consent/declaration.js";
import { capsFromOidcScopes, capsFromProjectDefinition, type ConsentCaps } from "../../src/consent/permission-keys.js";

const caps: ConsentCaps = {
  profileFields: ["displayName", "email"],
  identityClaims: ["discord_id"],
  userDataModules: ["calendar"],
  oidcScopes: [],
};

function permission(key: string, level: "required" | "recommended" = "recommended", visible: string[] = ["self"]) {
  return { key, level, purpose: `purpose of ${key}`, visible_to: visible };
}

function declaration(version: number, permissions: unknown[]) {
  return { version, permissions };
}

describe("validateConsentDeclaration — 上限の内側だけを保存する (設計書 §3)", () => {
  it("上限の内側の宣言を受け付ける", () => {
    const result = validateConsentDeclaration(declaration(1, [
      permission("profile.displayName", "required", ["service_users"]),
      permission("profile.email"),
      permission("identity_claim.discord_id"),
      permission("user_data.module:calendar"),
    ]), caps, null, null);
    expect(result.ok).toBe(true);
  });

  it.each([
    ["profile.avatarUrl", /outside the administrator grant/],
    ["identity_claim.discord_username", /outside the administrator grant/],
    ["user_data.module:notes", /outside the administrator grant/],
    ["oidc.email", /outside the administrator grant/],
    ["profile.password_hash", /unknown permission/],
    ["anything.goes", /unknown permission/],
  ])("上限外・語彙外の %s を拒否する", (key, message) => {
    const result = validateConsentDeclaration(declaration(1, [permission(key)]), caps, null, null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toMatch(message);
  });

  it("identity.basic を推奨にさせない", () => {
    const result = validateConsentDeclaration(declaration(1, [permission("identity.basic", "recommended")]), caps, null, null);
    expect(result.ok).toBe(false);
  });

  it("同じ権限の二重宣言を拒否する", () => {
    const result = validateConsentDeclaration(declaration(1, [permission("profile.email"), permission("profile.email")]), caps, null, null);
    expect(result.ok).toBe(false);
  });

  it("visible_to と purpose は省略できない", () => {
    const noVisible = validateConsentDeclaration(declaration(1, [{ key: "profile.email", level: "recommended", purpose: "x", visible_to: [] }]), caps, null, null);
    const noPurpose = validateConsentDeclaration(declaration(1, [{ key: "profile.email", level: "recommended", purpose: " ", visible_to: ["self"] }]), caps, null, null);
    expect(noVisible.ok).toBe(false);
    expect(noPurpose.ok).toBe(false);
  });

  it("サービスは other_services を申告できない (Cernere が data_sharing から足す)", () => {
    const result = validateConsentDeclaration(declaration(1, [permission("profile.email", "recommended", ["other_services"])]), caps, null, null);
    expect(result.ok).toBe(false);
  });

  it("版を下げる更新を拒否する", () => {
    const previous = { version: 3, permissions: [permission("profile.email")] } as never;
    const result = validateConsentDeclaration(declaration(2, [permission("profile.email")]), caps, 3, previous);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toMatch(/must not go down/);
  });

  it("版を据え置いたまま権限を増やす更新を拒否する (再確認を飛ばさせない)", () => {
    const previous = { version: 3, permissions: [permission("profile.email")] } as never;
    const result = validateConsentDeclaration(declaration(3, [permission("profile.email"), permission("profile.displayName")]), caps, 3, previous);
    expect(result.ok).toBe(false);
  });

  it("目的 (purpose) だけの変更は版を据え置いてよい", () => {
    const previous = { version: 3, permissions: [permission("profile.email")] } as never;
    const result = validateConsentDeclaration(declaration(3, [{ ...permission("profile.email"), purpose: "new wording" }]), caps, 3, previous);
    expect(result.ok).toBe(true);
  });
});

describe("上限 (caps) の導出", () => {
  it("profile_access / identity_claims / 論理削除されていない module から導く", () => {
    const derived = capsFromProjectDefinition({
      profile_access: { users: "all", read: ["displayName", "email"], write: ["bio"] },
      identity_claims: ["discord_id", "password_hash"],
      user_data: { columns: {
        a: { type: "text", module: "calendar" },
        b: { type: "text", module: "notes", _deleted: true },
      } },
    });
    expect(derived).toEqual({
      profileFields: ["displayName", "email", "bio"],
      identityClaims: ["discord_id"],
      userDataModules: ["calendar"],
      oidcScopes: [],
    });
  });

  it("OIDC client は scopes から oidc.* だけ (openid は identity.basic)", () => {
    expect(capsFromOidcScopes(["openid", "email", "profile"]).oidcScopes).toEqual(["email", "profile"]);
  });
});
