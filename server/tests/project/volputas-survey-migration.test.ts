import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../migrations/036_volputas_survey_responses.sql", import.meta.url),
  "utf8",
);

describe("036 Volputas survey response migration", () => {
  it("seeds the project and Excubitor issuer without fixed review columns", () => {
    expect(migration).toMatch(/INSERT INTO managed_projects[\s\S]*'volputas'/);
    expect(migration).toMatch(
      /VALUES \('volputas', 'excubitor', TRUE\)[\s\S]*ON CONFLICT/,
    );
    expect(migration).toMatch(/crypt\(gen_random_uuid\(\)::text, gen_salt\('bf', 12\)\)/);
    expect(migration).toMatch(
      /ON CONFLICT \(key\) DO UPDATE SET[\s\S]*schema_definition = EXCLUDED\.schema_definition/,
    );
    expect(migration).not.toMatch(/volputas_game_review/);
    expect(migration).not.toMatch(/\bgame_title\b|\boverall_rating\b/);
  });

  it("declares ownership, uniqueness, normalization, and lookup constraints", () => {
    expect(migration).toMatch(
      /user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/,
    );
    expect(migration).toMatch(/UNIQUE \(survey_id, user_id\)/);
    expect(migration).toMatch(/PRIMARY KEY \(response_id, question_id\)/);
    expect(migration).toMatch(
      /answer_text IS NOT NULL AND answer_int IS NULL[\s\S]*answer_text IS NULL AND answer_int IS NOT NULL/,
    );
    expect(migration).toMatch(/char_length\(answer_text\) <= 4000/);
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS/);
  });

  it("converges tables created by the earlier parallel response migration", () => {
    expect(migration).toMatch(
      /ALTER TABLE volputas_survey_responses[\s\S]*ADD CONSTRAINT uq_volputas_survey_response_survey_user/,
    );
    expect(migration).toMatch(
      /ALTER TABLE volputas_survey_answers[\s\S]*ADD CONSTRAINT chk_volputas_survey_answer_exactly_one/,
    );
    expect(migration).toMatch(
      /ADD CONSTRAINT chk_volputas_survey_answer_question_id/,
    );
    expect(migration).toMatch(
      /ADD CONSTRAINT chk_volputas_survey_answer_text_length/,
    );
  });

  it("fails closed on incompatible legacy rows and isolates convergence steps", () => {
    expect(migration).toMatch(
      /GROUP BY survey_id, user_id[\s\S]*HAVING count\(\*\) > 1/,
    );
    expect(migration).toMatch(/ERRCODE = 'P0001'/);
    expect(migration).toMatch(
      /to_regclass\('uq_volputas_survey_response_survey_user'\)/,
    );
    expect(migration.match(/DO \$\$/g)).toHaveLength(4);
  });

  it("contains no destructive schema operation", () => {
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
