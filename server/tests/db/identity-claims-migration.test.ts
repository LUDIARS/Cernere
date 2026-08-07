import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../../migrations/040_identity_claims.sql", import.meta.url), "utf8");

describe("040 identity claims migration", () => {
  it("adds the Discord identity without destructive operations", () => {
    expect(migration).toContain("discord_id TEXT UNIQUE");
    expect(migration).not.toMatch(/DROP (COLUMN|TABLE)/i);
  });

  it("特定サービス向けのテーブル / 列を作らない", () => {
    // サービス固有の project_data_<key> は schema-migrator が宣言から生成する。
    // migration にサービス名が現れたらハードコードの再発。
    expect(migration).not.toMatch(/project_data_\w+/);
    expect(migration).not.toMatch(/WHERE key = '/i);
  });
});
