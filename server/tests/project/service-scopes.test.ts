import { describe, expect, it } from "vitest";
import { declaredServiceScopes } from "../../src/project/service-scopes.js";
import {
  FACE_CONSENT_READ_SCOPE,
  FACE_CONSENT_REVOKE_SCOPE,
  FACE_REVOCATION_READ_SCOPE,
} from "../../src/http/face-identity-auth.js";

describe("declaredServiceScopes — 宣言からのみ scope を導出する", () => {
  it("宣言が無い / 配列でない定義からは何も導出しない", () => {
    expect(declaredServiceScopes(null)).toEqual([]);
    expect(declaredServiceScopes({})).toEqual([]);
    expect(declaredServiceScopes({ service_scopes: "review-relay:write" })).toEqual([]);
  });

  it("形式外の値を落とし、重複を除いて昇順で返す", () => {
    expect(declaredServiceScopes({
      service_scopes: ["review-relay:write", "persona-export:read", "review-relay:write", "BAD", 1, "x"],
    })).toEqual(["persona-export:read", "review-relay:write"]);
  });

  it("Cernere の face 系 scope 定数も宣言から導出できる (既存 Ostiarius 連携の語彙)", () => {
    const scopes = [FACE_REVOCATION_READ_SCOPE, FACE_CONSENT_READ_SCOPE, FACE_CONSENT_REVOKE_SCOPE];
    expect(declaredServiceScopes({ service_scopes: scopes })).toEqual([...scopes].sort());
  });
});
