/**
 * 共有を受けている列の宣言 (設計書 §8.1) — 共有元の readwrite grant の範囲内にある有効な列だけを受け付ける。
 */
import { describe, expect, it } from "vitest";
import { validateSignupFieldsDeclaration, type SignupSharing } from "../../src/signup-fields/declaration.js";
import type { SharedProjectDefinition } from "../../src/signup-fields/shared-source.js";
import { columns, consent, declaration, sharedDeclaration, sharedProfile } from "./fixtures.js";

function sharing(ownKey: string, source: SharedProjectDefinition | null = sharedProfile): SignupSharing {
  return { ownKey, sources: { vantan_user: source } };
}

function check(raw: unknown, shared: SignupSharing | undefined = sharing("EducationLab")) {
  return validateSignupFieldsDeclaration(raw, {}, null, null, shared);
}

function errorsOf(raw: unknown, shared?: SignupSharing): string {
  const result = check(raw, shared);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.errors.join("\n");
}

const field = (column: string, extra: Record<string, unknown> = {}) =>
  ({ version: 1, fields: [{ project: "vantan_user", column, label: "項目", input: "text", ...extra }] });

describe("validateSignupFieldsDeclaration (共有を受けている列)", () => {
  it("readwrite grant の範囲内の列は受け付ける (EducationLab: modules 指定の grant)", () => {
    expect(check(sharedDeclaration)).toEqual({ ok: true, declaration: sharedDeclaration });
  });

  it("columns を列挙した grant でも、その列なら受け付ける", () => {
    expect(check(sharedDeclaration, sharing("glab")).ok).toBe(true);
  });

  it("この project への grant が無ければ拒否する", () => {
    expect(errorsOf(sharedDeclaration, sharing("Other"))).toContain("no readwrite data_sharing grant for Other");
  });

  it("read のみの grant では拒否する (書けないので入力を求められない)", () => {
    expect(errorsOf(sharedDeclaration, sharing("aedilis"))).toContain("no readwrite data_sharing grant for aedilis");
  });

  it("grant の範囲外の列は拒否する (columns の外・modules の外)", () => {
    expect(errorsOf(field("grade", { input: "number" }), sharing("glab")))
      .toContain("grade of vantan_user is outside the data_sharing grant for glab");
    expect(errorsOf(field("note"))).toContain("note of vantan_user is outside the data_sharing grant for EducationLab");
  });

  it("共有元に存在しない列・論理削除済みの列は拒否する", () => {
    expect(errorsOf(field("nope"))).toContain("nope is not an active user_data column of vantan_user");
    expect(errorsOf(field("old_title"))).toContain("old_title is not an active user_data column of vantan_user");
  });

  it("共有元 project が無い・無効なら拒否する (検証材料が無い呼び出しも同じ)", () => {
    expect(errorsOf(sharedDeclaration, sharing("EducationLab", null))).toContain("vantan_user is not an active project");
    const withoutSharing = validateSignupFieldsDeclaration(sharedDeclaration, {}, null, null);
    expect(withoutSharing).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining("vantan_user is not an active project")]) });
  });

  it("共有元の列でも型と input が合わなければ拒否する", () => {
    expect(errorsOf(field("name", { input: "number" }))).toContain("number does not fit column type text");
  });

  it("project が自分の key なら自分の列として検証する", () => {
    const own = { version: 1, fields: [{ project: "EducationLab", column: "affiliation", label: "所属", input: "text" }] };
    expect(validateSignupFieldsDeclaration(own, columns, consent, null, sharing("EducationLab")).ok).toBe(true);
  });

  it("列名は project をまたいでも一意 (同じ列名は 2 つ書けない)", () => {
    const both = { version: 1, fields: [
      { column: "name", label: "名前", input: "text" },
      { project: "vantan_user", column: "name", label: "名前", input: "text" },
    ] };
    expect(validateSignupFieldsDeclaration(both, { name: { type: "text" } }, null, null, sharing("EducationLab")))
      .toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining("duplicate column name")]) });
  });

  it("自分の列と共有元の列を混ぜられ、推奨 module の検査は自分の列だけに掛かる", () => {
    const mixed = { version: 1, fields: [...declaration.fields, ...sharedDeclaration.fields] };
    expect(validateSignupFieldsDeclaration(mixed, columns, consent, null, sharing("EducationLab")).ok).toBe(true);
  });
});
