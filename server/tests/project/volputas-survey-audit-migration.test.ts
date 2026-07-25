import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../migrations/037_volputas_survey_access_logs.sql", import.meta.url),
  "utf8",
);

/**
 * 「保存しない」系の検査は実 DDL に対して行う。コメントは「何を保存しないか」を
 * 説明するために token / payload といった語を正当に含むため、そのまま検査すると
 * 説明文を書いた瞬間に落ちる。
 */
const ddl = migration.replace(/--[^\n]*/g, "");

describe("037 Volputas survey access audit migration", () => {
  it("stores only audit metadata columns", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS volputas_survey_access_logs/);
    for (const column of [
      "project_key TEXT NOT NULL",
      "user_id UUID",
      "survey_id UUID",
      "action TEXT NOT NULL",
      "status TEXT NOT NULL",
      "error_code TEXT",
      "created_at TIMESTAMPTZ NOT NULL DEFAULT now()",
    ]) {
      expect(migration).toContain(column);
    }
  });

  it("has no column able to hold answers, payloads or credentials", () => {
    expect(ddl).not.toMatch(/\banswer_text\b|\banswer_int\b|\banswers\b/);
    expect(ddl).not.toMatch(/\bparams\b|\bpayload\b/);
    expect(ddl).not.toMatch(/\btoken\b|\bsecret\b|\bcredential\b/i);
    // 自由文 error 列を作らない (error_code の閉じた区分だけ)。
    expect(ddl).not.toMatch(/\berror TEXT\b/);
  });

  it("pins action and status to closed enumerations", () => {
    expect(migration).toMatch(
      /action IN \('list_response_statuses', 'get_response', 'save_response'\)/,
    );
    expect(migration).toMatch(/status IN \('ok', 'error', 'denied'\)/);
  });

  it("fail-closes the error code against free text and pairs it with status", () => {
    expect(migration).toMatch(/status = 'ok' AND error_code IS NULL/);
    expect(migration).toMatch(
      /status <> 'ok' AND error_code IN \([\s\S]*'project_not_authorized'[\s\S]*'invalid_payload'[\s\S]*'storage_failure'[\s\S]*'internal_error'[\s\S]*\)/,
    );
  });

  it("indexes the audit lookups and the retention sweep", () => {
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_volputas_survey_access_logs_user/,
    );
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_volputas_survey_access_logs_project/,
    );
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_volputas_survey_access_logs_created/,
    );
  });

  it("omits the users FK so denied attempts cannot be rejected on insert", () => {
    expect(ddl).not.toMatch(/REFERENCES users/);
  });

  it("contains no destructive schema operation", () => {
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/\bALTER TABLE\b/i);
  });

  it("does not touch the reserved 030-035 range or migration 036", () => {
    expect(ddl).not.toMatch(/volputas_survey_responses|volputas_survey_answers/);
    expect(ddl).not.toMatch(/INSERT INTO managed_projects/);
  });
});
