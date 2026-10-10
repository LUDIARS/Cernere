import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitStatements } from "../../src/db/migration-files.js";

const migration = readFileSync(
  new URL("../../../migrations/063_rename_volputas_to_voluptas.sql", import.meta.url),
  "utf8",
);

describe("063 volputas → voluptas managed project key rename", () => {
  it("runs as a single atomic statement so the runner cannot half-apply it", () => {
    const statements = splitStatements(migration).filter((statement) => statement.trim().length > 0);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^\s*(--[^\n]*\n\s*)*DO \$\$/);
  });

  it("is idempotent: skips when voluptas exists or volputas is missing", () => {
    expect(migration).toMatch(/IF EXISTS \(SELECT 1 FROM managed_projects WHERE key = 'voluptas'\) THEN[\s\S]*?RETURN;/);
    expect(migration).toMatch(/IF NOT EXISTS \(SELECT 1 FROM managed_projects WHERE key = 'volputas'\) THEN[\s\S]*?RETURN;/);
  });

  it("re-creates every key FK with ON UPDATE CASCADE and keeps its ON DELETE action", () => {
    expect(migration).toMatch(/c\.confrelid = 'managed_projects'::regclass/);
    expect(migration).toMatch(/c\.confupdtype <> 'c'/);
    expect(migration).toMatch(/ON UPDATE CASCADE ON DELETE %s/);
    expect(migration).toMatch(/WHEN 'c' THEN 'CASCADE'/);
  });

  it("renames the key but never touches storage_slug or project data tables", () => {
    expect(migration).toMatch(/UPDATE managed_projects\s+SET key = 'voluptas'/);
    expect(migration).not.toMatch(/storage_slug\s*=/);
    expect(migration).not.toMatch(/ALTER TABLE[^;]*RENAME/i);
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN/i);
  });

  it("moves FK-less project_key rows and keeps the schema definition key in sync", () => {
    expect(migration).toMatch(/UPDATE project_oauth_tokens SET project_key = 'voluptas' WHERE project_key = 'volputas'/);
    expect(migration).toMatch(/UPDATE edge_idp_bindings SET project_key = 'voluptas' WHERE project_key = 'volputas'/);
    expect(migration).toMatch(/'\{project,key\}', '"voluptas"'::jsonb/);
  });
});
