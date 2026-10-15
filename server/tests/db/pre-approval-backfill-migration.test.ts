import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitStatements } from "../../src/db/migration-files.js";

const migration = readFileSync(
  new URL("../../../migrations/071_backfill_pre_approval_users_active.sql", import.meta.url),
  "utf8",
);
const body = migration.replace(/--[^\n]*\n/g, "");

describe("071 activates users that existed before registration approval (068)", () => {
  it("runs as a single statement so the runner cannot half-apply it", () => {
    const statements = splitStatements(migration).filter((statement) => statement.trim().length > 0);
    expect(statements).toHaveLength(1);
  });

  it("only targets pending users created before 068 was applied", () => {
    expect(body).toMatch(/FROM _migrations WHERE version = '068_registration_approval'/);
    expect(body).toMatch(/u\.access_status = 'pending'/);
    expect(body).toMatch(/u\.created_at < c\.applied_at/);
  });

  it("never touches locked users or users that are already active", () => {
    expect(body).not.toMatch(/access_status\s*(=|IN)\s*\(?\s*'locked'/);
    expect(body).not.toMatch(/access_status\s*<>/);
  });

  it("records an audit row and bumps the revision with the status change", () => {
    expect(body).toMatch(/INSERT INTO access_decisions/);
    expect(body).toMatch(/'pending', 'active', 'pre_approval_backfill'/);
    expect(body).toMatch(/access_revision = u\.access_revision \+ 1/);
    expect(body).toMatch(/access_changed_at = now\(\)/);
  });

  it("does not drop or retype anything", () => {
    expect(body).not.toMatch(/DROP TABLE|DROP COLUMN|ALTER COLUMN/i);
  });
});
