import { describe, expect, it } from "vitest";
import {
  MAX_STORAGE_SLUG_LENGTH,
  STORAGE_SLUG_REGEX,
  assertStorageSlug,
  deriveStorageSlug,
  pickUniqueStorageSlug,
  storageTableName,
} from "../../src/project/storage-slug.js";
import { projectDefinitionSchema } from "../../src/project/schema.js";

describe("storage slug (project key と切り離した SQL 識別子)", () => {
  it("安全な key はそのまま slug になる (既存 project_data_<key> が動き続ける)", () => {
    expect(deriveStorageSlug("glab")).toBe("glab");
    expect(deriveStorageSlug("vantan_user")).toBe("vantan_user");
  });

  it("大文字やハイフンを含む key も slug へ畳める (EducationLab の実害を止める)", () => {
    expect(deriveStorageSlug("EducationLab")).toBe("educationlab");
    expect(deriveStorageSlug("My-App")).toBe("my_app");
  });

  it("先頭が英字でなければ p_ を前置し、50 文字で切る", () => {
    expect(deriveStorageSlug("1abc")).toBe("p_1abc");
    expect(deriveStorageSlug("_x")).toBe("p__x");
    const long = "a".repeat(80);
    expect(deriveStorageSlug(long)).toHaveLength(MAX_STORAGE_SLUG_LENGTH);
    expect(STORAGE_SLUG_REGEX.test(deriveStorageSlug(long))).toBe(true);
  });

  it("導出結果は必ず migration 043 の CHECK と同じ規則を満たす", () => {
    for (const key of ["EducationLab", "1abc", "a-b-c", "ÄÖ", "x"]) {
      expect(STORAGE_SLUG_REGEX.test(deriveStorageSlug(key))).toBe(true);
    }
  });

  it("衝突する slug には _2, _3 ... を付け、50 文字に収める", () => {
    expect(pickUniqueStorageSlug("app", new Set())).toBe("app");
    expect(pickUniqueStorageSlug("app", new Set(["app"]))).toBe("app_2");
    expect(pickUniqueStorageSlug("app", new Set(["app", "app_2"]))).toBe("app_3");
    const long = "b".repeat(MAX_STORAGE_SLUG_LENGTH);
    const picked = pickUniqueStorageSlug(long, new Set([long]));
    expect(picked).toHaveLength(MAX_STORAGE_SLUG_LENGTH);
    expect(picked.endsWith("_2")).toBe(true);
    expect(() => pickUniqueStorageSlug("bad-slug", new Set())).toThrow(/invalid storage slug/);
  });

  it("表名の組み立ては検証済み slug からしか行わない", () => {
    expect(storageTableName("glab")).toBe("project_data_glab");
    expect(storageTableName("user")).toBe("project_data_user");
    expect(() => storageTableName("EducationLab")).toThrow(/invalid storage slug/);
    expect(() => storageTableName('x"; DROP TABLE users; --')).toThrow(/invalid storage slug/);
    expect(() => storageTableName(null)).toThrow(/invalid storage slug/);
    expect(() => storageTableName(undefined)).toThrow(/invalid storage slug/);
    expect(() => assertStorageSlug("a".repeat(MAX_STORAGE_SLUG_LENGTH + 1))).toThrow();
  });
});

describe("project key の文字種制約 (storage から切れたので緩める)", () => {
  function definitionWithKey(key: string) {
    return projectDefinitionSchema.safeParse({
      project: { key, name: "X", description: "" },
    });
  }

  it("大文字・ハイフンを含む key を受理する", () => {
    expect(definitionWithKey("EducationLab").success).toBe(true);
    expect(definitionWithKey("my-app").success).toBe(true);
    expect(definitionWithKey("glab").success).toBe(true);
  });

  it("URL / log に出るので空白・記号・非 ASCII・数字始まりは引き続き拒否する", () => {
    for (const key of ["my app", "a/b", "../x", "1abc", "-abc", "日本語", "a"]) {
      expect(definitionWithKey(key).success, key).toBe(false);
    }
  });
});
