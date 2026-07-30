import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { columnDefinitionSchema } from "../../src/project/schema.js";

const migration = readFileSync(
  new URL("../../../migrations/037_volputas_profile_evidence_schema.sql", import.meta.url),
  "utf8",
);

/**
 * Volputas の CernereProfileEvidenceStore が managed_project 経由で読み書きする
 * カラム名 (COLUMN_BY_KIND + persona/media)。Volputas 側で媒体を増やしてここへの
 * 追加を忘れると setUserData が "No valid columns to update" で落ちるため、
 * 名前を固定して取り残しを検知する。
 */
const REQUIRED_COLUMNS = [
  "gameplay_records",
  "voice_records",
  "voicememo_records",
  "emotion_curve_records",
  "comparison_records",
  "card_sort_records",
  "annotation_records",
  "pitch_records",
  "persona_analysis",
  "profile_media",
];

/** migration が INSERT する schema_definition の JSON リテラルを取り出す。 */
function parseSchemaDefinition(): {
  user_data?: { columns?: Record<string, unknown> };
} {
  const match = migration.match(/'(\{[\s\S]*?\})'::jsonb/);
  if (!match) throw new Error("schema_definition JSON literal not found in migration");
  return JSON.parse(match[1]);
}

describe("037 Volputas profile evidence schema", () => {
  const definition = parseSchemaDefinition();
  const columns = definition.user_data?.columns ?? {};

  it("publishes every column the Volputas online store reads and writes", () => {
    expect(Object.keys(columns).sort()).toEqual([...REQUIRED_COLUMNS].sort());
  });

  it("declares each column so the schema migrator can materialise it", () => {
    for (const [name, columnDefinition] of Object.entries(columns)) {
      // module 必須・type が COLUMN_TYPE_MAP のキーであることを Cernere 本体の
      // zod スキーマそのもので検証する (migration 側だけ緩む事故を防ぐ)。
      const parsed = columnDefinitionSchema.safeParse(columnDefinition);
      expect(parsed.success, `${name}: ${parsed.error?.message ?? ""}`).toBe(true);
      expect(parsed.data?.type).toBe("json");
    }
  });

  it("keeps the physical table in sync with the declared columns", () => {
    const createTable = migration.match(
      /CREATE TABLE IF NOT EXISTS "project_data_volputas"\s*\(([\s\S]*?)\n\);/,
    );
    expect(createTable).not.toBeNull();

    for (const name of Object.keys(columns)) {
      expect(createTable?.[1]).toContain(`"${name}"`);
    }
    // 宣言と ALTER の集合が一致すること (どちらかの取り残しを検知)。
    const altered = [...migration.matchAll(/ADD COLUMN IF NOT EXISTS "([a-z_]+)" JSONB/g)]
      .map((entry) => entry[1]);
    expect(altered.sort()).toEqual(Object.keys(columns).sort());
  });

  it("creates a Cernere-owned per-user table with cascading ownership", () => {
    expect(migration).toMatch(/user_id\s+UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
    expect(migration).toMatch(/PRIMARY KEY \(user_id\)/);
  });

  it("converges existing Volputas project registrations without destructive DDL", () => {
    expect(migration).toMatch(/ON CONFLICT \(key\) DO UPDATE SET/);
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
