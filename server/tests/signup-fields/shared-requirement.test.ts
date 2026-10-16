/**
 * 共有を受けている列の要否と画面データ (設計書 §8.2 / §8.3)。
 */
import { describe, expect, it } from "vitest";
import { evaluateSignupFields, type SignupFieldsInput, type SignupSourceColumns } from "../../src/signup-fields/requirement.js";
import { columns, consent, declaration, sharedDeclaration } from "./fixtures.js";

const profile: SignupSourceColumns = {
  columns: { name: { type: "text", module: "profile" }, role_title: { type: "text", module: "profile" }, department_name: { type: "text", module: "profile" } },
  sharedWith: { name: ["Aedilis"], role_title: ["Aedilis"], department_name: [] },
};

function input(partial: Partial<SignupFieldsInput> = {}): SignupFieldsInput {
  return {
    declaration: sharedDeclaration, columns: {}, ownKey: "EducationLab", sources: { vantan_user: profile },
    consent: null, values: {}, deniedModules: new Set(), seen: { version: null, columns: [] },
    ...partial,
  };
}

describe("evaluateSignupFields (共有を受けている列)", () => {
  it("共有元の未入力の必須を不足に数え、保存先と共有先を載せる", () => {
    const result = evaluateSignupFields(input());
    expect(result.missingRequired).toEqual(["name", "role_title", "department_name"]);
    expect(result.fields[0]).toMatchObject({ project: "vantan_user", column: "name", visibleTo: null, sharedWith: ["Aedilis"] });
    expect(result.fields[2].sharedWith).toEqual([]);
  });

  it("共有元の行に入っている値は聞かない", () => {
    const result = evaluateSignupFields(input({ values: { name: "山田", role_title: "講師" } }));
    expect(result.missingRequired).toEqual(["department_name"]);
    expect(result.all[0]).toMatchObject({ filled: true, value: "山田" });
  });

  it("grant が外れた project・範囲外になった列は聞かない (fail closed)", () => {
    expect(evaluateSignupFields(input({ sources: {} })).all).toEqual([]);
    const narrowed = { ...profile, columns: { name: profile.columns.name } };
    expect(evaluateSignupFields(input({ sources: { vantan_user: narrowed } })).all.map((f) => f.column)).toEqual(["name"]);
  });

  it("同意で拒否された module は自分の列にだけ掛かる (共有元の module 名が同じでも聞く)", () => {
    const result = evaluateSignupFields(input({ deniedModules: new Set(["profile"]) }));
    expect(result.missingRequired).toEqual(["name", "role_title", "department_name"]);
  });

  it("自分の列は今どおり (project は null、visibleTo は consent から)", () => {
    const mixed = { version: 1, fields: [...declaration.fields, ...sharedDeclaration.fields] };
    const result = evaluateSignupFields(input({ declaration: mixed, columns, consent }));
    expect(result.all.find((f) => f.column === "affiliation")).toMatchObject({ project: null, visibleTo: ["service_users"], sharedWith: null });
    expect(result.missingRequired).toEqual(["affiliation", "name", "role_title", "department_name"]);
  });
});
