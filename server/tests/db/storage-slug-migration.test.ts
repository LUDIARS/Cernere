import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STORAGE_SLUG_REGEX } from "../../src/project/storage-slug.js";

const migration = readFileSync(
  new URL("../../../migrations/043_managed_projects_storage_slug.sql", import.meta.url),
  "utf8",
);

describe("043 managed_projects.storage_slug migration", () => {
  it("storage_slug を追加し、backfill 後に NOT NULL / UNIQUE / CHECK を掛ける", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS storage_slug TEXT");
    expect(migration).toMatch(/UPDATE managed_projects[\s\S]*SET storage_slug/);
    expect(migration).toContain("ALTER COLUMN storage_slug SET NOT NULL");
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS \w+ ON managed_projects \(storage_slug\)/);
    expect(migration).toContain("i.indisunique");
    expect(migration).toContain("i.indisvalid");
    expect(migration).toContain("CHECK (storage_slug ~");
  });

  it("衝突時は確定済み slug を再確認し、suffix 分を残して採番する", () => {
    expect(migration).toMatch(/WHILE EXISTS \([\s\S]*storage_slug = candidate/);
    expect(migration).toContain("50 - length(suffix)");
    expect(migration).toContain("ORDER BY (key = base) DESC, key");
  });

  it("CHECK の正規表現はサーバー側 STORAGE_SLUG_REGEX と一致する", () => {
    const m = /CHECK \(storage_slug ~ '([^']+)'\)/.exec(migration);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(STORAGE_SLUG_REGEX.source);
  });

  it("破壊的操作と特定サービス名のハードコードを含まない", () => {
    expect(migration).not.toMatch(/DROP (COLUMN|TABLE)/i);
    expect(migration).not.toMatch(/project_data_\w+/);
    expect(migration).not.toMatch(/WHERE key = '/i);
  });
});
