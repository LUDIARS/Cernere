/**
 * 入力値の検証 (設計書 §4.1) — 聞いた列だけ受け付け、必須の空欄・型や選択肢の外れは項目ごとのエラーにする。
 */
import { describe, expect, it } from "vitest";
import { evaluateSignupFields } from "../../src/signup-fields/requirement.js";
import { validateSignupFieldValues } from "../../src/signup-fields/values.js";
import { columns, consent, declaration } from "./fixtures.js";

const withMore = {
  version: 1,
  fields: [
    ...declaration.fields,
    { column: "agreed", label: "規約", required: false, input: "boolean" as const },
    { column: "seat", label: "席", required: false, input: "number" as const },
  ],
};
const fields = evaluateSignupFields({
  declaration: withMore, columns, consent, values: {}, deniedModules: new Set(), seen: { version: null, columns: [] },
}).fields;

describe("validateSignupFieldValues", () => {
  it("正しい値を正規化して返し、聞いていない列は捨てる", () => {
    expect(validateSignupFieldValues(fields, {
      affiliation: "  ゲーム制作学科 ", grade: "2", agreed: true, seat: "12", joined_at: "2026-01-01", legacy: "x",
    })).toEqual({ ok: true, values: { affiliation: "ゲーム制作学科", grade: "2", agreed: true, seat: 12 } });
  });

  it("必須の空欄・送られなかった必須はエラー", () => {
    expect(validateSignupFieldValues(fields, { affiliation: "  " })).toEqual({ ok: false, errors: { affiliation: "入力してください" } });
    expect(validateSignupFieldValues(fields, {})).toEqual({ ok: false, errors: { affiliation: "入力してください" } });
  });

  it("文字数超過・選択肢の外・型違い・範囲外は項目ごとのエラーにし、値を 1 つも返さない", () => {
    const result = validateSignupFieldValues(fields, {
      affiliation: "あ".repeat(11), grade: "9", agreed: "yes", seat: 3_000_000_000,
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        affiliation: "10 文字以内で入力してください",
        grade: "選択肢から選んでください",
        agreed: "はい / いいえで選んでください",
        seat: "大きすぎる数です",
      },
    });
  });

  it("任意の空欄は null (消す) として受け付ける", () => {
    expect(validateSignupFieldValues(fields, { affiliation: "A", bio: "", seat: "" }))
      .toEqual({ ok: true, values: { affiliation: "A", bio: null, seat: null } });
  });
});
