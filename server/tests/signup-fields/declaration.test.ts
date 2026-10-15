/**
 * 入力項目の宣言の検証 (設計書 §2 / §7) — 存在しない列・型の不一致・推奨 module の列を必須にする宣言を拒否する。
 */
import { describe, expect, it } from "vitest";
import { validateSignupFieldsDeclaration } from "../../src/signup-fields/declaration.js";
import { columns, consent, declaration } from "./fixtures.js";

function check(raw: unknown, previousVersion: number | null = null) {
  return validateSignupFieldsDeclaration(raw, columns, consent, previousVersion);
}

function errorsOf(raw: unknown, previousVersion: number | null = null): string {
  const result = check(raw, previousVersion);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.errors.join("\n");
}

describe("validateSignupFieldsDeclaration", () => {
  it("有効な列・型の合う入力・必須 module の列を必須にした宣言は通す", () => {
    expect(check(declaration)).toEqual({ ok: true, declaration });
  });

  it("存在しない列と論理削除済みの列は拒否する", () => {
    expect(errorsOf({ version: 1, fields: [{ column: "nope", label: "無い", input: "text" }] }))
      .toContain("nope is not an active user_data column");
    expect(errorsOf({ version: 1, fields: [{ column: "legacy", label: "旧", input: "text" }] }))
      .toContain("legacy is not an active user_data column");
  });

  it("列の型と入力の種類が合わなければ拒否する", () => {
    expect(errorsOf({ version: 1, fields: [{ column: "affiliation", label: "所属", input: "number" }] }))
      .toContain("number does not fit column type text");
    expect(errorsOf({ version: 1, fields: [{ column: "joined_at", label: "入会日", input: "text" }] }))
      .toContain("text does not fit column type timestamp");
    expect(check({ version: 1, fields: [
      { column: "seat", label: "席", input: "number" }, { column: "agreed", label: "同意", input: "boolean" },
    ] }).ok).toBe(true);
  });

  it("推奨 module の列は必須にできない (推奨を外した人に入力を強制しない)", () => {
    expect(errorsOf({ version: 1, fields: [{ column: "bio", label: "自己紹介", required: true, input: "text" }] }))
      .toContain("recommended module social");
  });

  it("形の誤り (select の options 無し・ラベル無し・件数超過・重複) を拒否する", () => {
    expect(errorsOf({ version: 1, fields: [{ column: "grade", label: "学年", input: "select" }] })).toContain("select needs options");
    expect(errorsOf({ version: 1, fields: [{ column: "grade", label: "", input: "text" }] })).toContain("label");
    expect(errorsOf({ version: 1, fields: Array.from({ length: 21 }, () => ({ column: "grade", label: "学年", input: "text" })) }))
      .toContain("signup_fields.fields");
    expect(errorsOf({ version: 1, fields: [
      { column: "grade", label: "学年", input: "text" }, { column: "grade", label: "学年2", input: "text" },
    ] })).toContain("duplicate column grade");
  });

  it("版を下げる更新は拒否する", () => {
    expect(errorsOf({ ...declaration, version: 1 }, 2)).toContain("must not go down");
    expect(check({ ...declaration, version: 2 }, 2).ok).toBe(true);
  });
});
