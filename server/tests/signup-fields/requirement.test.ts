/**
 * 入力項目の要否 (設計書 §3 / §7) — 未入力の必須だけ不足に数える / 入力済みは聞かない /
 * 拒否 module の列は聞かない / 同じ版では任意を再表示しない / 版上げで新項目だけ。
 */
import { describe, expect, it } from "vitest";
import { evaluateSignupFields, type SignupFieldsInput } from "../../src/signup-fields/requirement.js";
import { columns, consent, declaration } from "./fixtures.js";

function input(partial: Partial<SignupFieldsInput> = {}): SignupFieldsInput {
  return {
    declaration, columns, consent, values: {}, deniedModules: new Set(), seen: { version: null, columns: [] },
    ...partial,
  };
}

describe("evaluateSignupFields", () => {
  it("宣言の無いサービスは何も聞かない", () => {
    expect(evaluateSignupFields(input({ declaration: null }))).toMatchObject({ declared: false, missingRequired: [], fields: [] });
  });

  it("未入力の必須だけを不足に数え、未入力の任意は一緒に聞く", () => {
    const result = evaluateSignupFields(input());
    expect(result.missingRequired).toEqual(["affiliation"]);
    expect(result.optionalUnfilled).toEqual(["grade", "bio"]);
    expect(result.fields.map((f) => f.column)).toEqual(["affiliation", "grade", "bio"]);
  });

  it("入力済みの項目は聞かない (空白だけは未入力)", () => {
    const result = evaluateSignupFields(input({ values: { affiliation: "ゲーム制作学科", grade: "  " } }));
    expect(result.missingRequired).toEqual([]);
    expect(result.fields.map((f) => f.column)).toEqual(["grade", "bio"]);
    expect(result.all.find((f) => f.column === "affiliation")).toMatchObject({ filled: true, value: "ゲーム制作学科" });
  });

  it("同意で拒否された module の列は聞かない", () => {
    const result = evaluateSignupFields(input({ deniedModules: new Set(["social"]) }));
    expect(result.all.map((f) => f.column)).toEqual(["affiliation", "grade"]);
    expect(result.fields.map((f) => f.column)).not.toContain("bio");
  });

  it("「誰が読めるか」はその列の module の consent 宣言から引く", () => {
    const result = evaluateSignupFields(input());
    expect(result.all.find((f) => f.column === "affiliation")?.visibleTo).toEqual(["service_users"]);
    expect(result.all.find((f) => f.column === "bio")?.visibleTo).toEqual(["public"]);
    expect(evaluateSignupFields(input({ consent: null })).all[0].visibleTo).toBeNull();
  });

  it("同じ版で一度見せた任意は、空のままでも再表示しない (必須は聞き続ける)", () => {
    const result = evaluateSignupFields(input({ seen: { version: 1, columns: ["affiliation", "grade", "bio"] } }));
    expect(result.optionalUnfilled).toEqual([]);
    expect(result.fields.map((f) => f.column)).toEqual(["affiliation"]);
  });

  it("版が上がったら、まだ見せていない未入力の任意だけを出す", () => {
    const v2 = {
      version: 2,
      fields: [...declaration.fields, { column: "agreed", label: "規約", required: false, input: "boolean" as const }],
    };
    const result = evaluateSignupFields(input({
      declaration: v2,
      values: { affiliation: "A" },
      seen: { version: 1, columns: ["affiliation", "grade", "bio"] },
    }));
    expect(result.missingRequired).toEqual([]);
    expect(result.optionalUnfilled).toEqual(["agreed"]);
  });

  it("宣言後に論理削除された列は聞かない", () => {
    const result = evaluateSignupFields(input({
      columns: { ...columns, affiliation: { type: "text", module: "member", _deleted: true } },
    }));
    expect(result.missingRequired).toEqual([]);
    expect(result.all.map((f) => f.column)).not.toContain("affiliation");
  });
});
