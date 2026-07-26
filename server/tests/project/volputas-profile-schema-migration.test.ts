import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../migrations/037_volputas_profile_evidence_schema.sql", import.meta.url),
  "utf8",
);

describe("037 Volputas profile evidence schema", () => {
  it("publishes all online profile columns through the managed project schema", () => {
    for (const column of [
      "gameplay_records",
      "voice_records",
      "emotion_curve_records",
      "persona_analysis",
      "profile_media",
    ]) {
      expect(migration).toContain(`"${column}"`);
    }
    expect(migration).toMatch(/"module": "profile_evidence"/);
    expect(migration).toMatch(/"module": "persona"/);
    expect(migration).toMatch(/"module": "profile_media"/);
  });

  it("creates a Cernere-owned per-user table with cascading ownership", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS "project_data_volputas"/);
    expect(migration).toMatch(/user_id\s+UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
    expect(migration).toMatch(/PRIMARY KEY \(user_id\)/);
  });

  it("converges existing Volputas project registrations without destructive DDL", () => {
    expect(migration).toMatch(/ON CONFLICT \(key\) DO UPDATE SET/);
    expect(migration.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(5);
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
