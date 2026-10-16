/**
 * 入力項目の保存先表の振り分け (設計書 §8.2) — 自分の列は自分の表、共有を受けている列は共有元の表。
 */
import { describe, expect, it } from "vitest";
import { evaluateSignupFields } from "../../src/signup-fields/requirement.js";
import { readableColumnsByTable, valuesByTable } from "../../src/signup-fields/targets.js";
import { columns, consent, declaration, sharedDeclaration } from "./fixtures.js";

const mixed = { version: 1, fields: [...declaration.fields, ...sharedDeclaration.fields] };
const own = { projectKey: "EducationLab", storageTable: "project_data_educationlab", columns };
const vantan = {
  projectKey: "vantan_user",
  storageTable: "project_data_vantan_user",
  columns: { name: { type: "text" }, role_title: { type: "text" }, department_name: { type: "text" } },
};

describe("readableColumnsByTable", () => {
  it("field ごとの保存先表に分ける", () => {
    expect(readableColumnsByTable(mixed, own, { vantan_user: vantan })).toEqual([
      { projectKey: "EducationLab", table: "project_data_educationlab", columns: ["affiliation", "grade", "bio"] },
      { projectKey: "vantan_user", table: "project_data_vantan_user", columns: ["name", "role_title", "department_name"] },
    ]);
  });

  it("grant の外れた共有元の列は読まない", () => {
    expect(readableColumnsByTable(mixed, own, {}).map((g) => g.table)).toEqual(["project_data_educationlab"]);
  });
});

describe("valuesByTable", () => {
  const views = evaluateSignupFields({
    declaration: mixed, columns, ownKey: "EducationLab",
    sources: { vantan_user: { columns: vantan.columns, sharedWith: {} } },
    consent, values: {}, deniedModules: new Set(), seen: { version: null, columns: [] },
  }).all;

  it("共有元の列の値は共有元の表へ、自分の列は自分の表へ書く", () => {
    expect(valuesByTable({ affiliation: "学科A", name: "山田", role_title: "講師" }, views, own, { vantan_user: vantan })).toEqual([
      { projectKey: "EducationLab", table: "project_data_educationlab", values: { affiliation: "学科A" } },
      { projectKey: "vantan_user", table: "project_data_vantan_user", values: { name: "山田", role_title: "講師" } },
    ]);
  });

  it("自分の表は値が無くても先頭に置き (行を作る)、共有元は値があるときだけ", () => {
    expect(valuesByTable({}, views, own, { vantan_user: vantan })).toEqual([
      { projectKey: "EducationLab", table: "project_data_educationlab", values: {} },
    ]);
  });

  it("聞いていない列・保存先の解決できない列は書かない", () => {
    expect(valuesByTable({ name: "山田", joined_at: "x" }, views, own, {})).toEqual([
      { projectKey: "EducationLab", table: "project_data_educationlab", values: {} },
    ]);
  });
});
