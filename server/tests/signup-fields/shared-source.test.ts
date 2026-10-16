/**
 * 共有元の書ける列 (設計書 §8.1 / §8.3) — readwrite grant の範囲内の有効な列と、列を読める他の共有先。
 */
import { describe, expect, it } from "vitest";
import { fieldSourceProject, otherProjectsSharing, writableSharedColumns } from "../../src/signup-fields/shared-source.js";
import { sharedProfile } from "./fixtures.js";

describe("writableSharedColumns", () => {
  it("modules 指定の readwrite grant は、その module の有効な列を返す", () => {
    expect(Object.keys(writableSharedColumns(sharedProfile, "EducationLab") ?? {}))
      .toEqual(["name", "role_title", "department_name", "grade"]);
  });

  it("columns 指定の grant は列挙した列だけ", () => {
    expect(Object.keys(writableSharedColumns(sharedProfile, "glab") ?? {})).toEqual(["name", "role_title", "department_name"]);
  });

  it("grant が無い・read のみ・access の無い grant は null", () => {
    expect(writableSharedColumns(sharedProfile, "Other")).toBeNull();
    expect(writableSharedColumns(sharedProfile, "aedilis")).toBeNull();
    expect(writableSharedColumns({ ...sharedProfile, dataSharing: [{ project_key: "EducationLab" }] }, "EducationLab")).toBeNull();
  });
});

describe("otherProjectsSharing", () => {
  it("列を読める project (read / readwrite) から自分を除いて返す", () => {
    expect(otherProjectsSharing(sharedProfile, "name", "EducationLab")).toEqual(["aedilis", "glab"]);
    expect(otherProjectsSharing(sharedProfile, "grade", "EducationLab")).toEqual(["aedilis"]);
  });
});

describe("fieldSourceProject", () => {
  it("project 省略・自分の key は自分の列 (null)", () => {
    expect(fieldSourceProject({}, "EducationLab")).toBeNull();
    expect(fieldSourceProject({ project: "EducationLab" }, "EducationLab")).toBeNull();
    expect(fieldSourceProject({ project: "vantan_user" }, "EducationLab")).toBe("vantan_user");
  });
});
