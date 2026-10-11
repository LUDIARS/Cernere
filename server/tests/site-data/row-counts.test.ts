import { describe, expect, it } from "vitest";
import { backupDatabaseName } from "../../scripts/site-data/backup-name.js";
import { compareRowCounts } from "../../scripts/site-data/row-counts.js";
import { NOW } from "./fakes.js";

describe("row count comparison", () => {
  it("is empty only for the same tables with the same counts", () => {
    expect(compareRowCounts({ "public.a": 1, "public.b": 0 }, { "public.b": 0, "public.a": 1 })).toEqual([]);
  });

  it("reports missing, extra and differing tables", () => {
    expect(compareRowCounts({ "public.a": 1, "public.b": 2 }, { "public.b": 3, "public.c": 0 })).toEqual([
      { table: "public.a", expected: 1, actual: null },
      { table: "public.b", expected: 2, actual: 3 },
      { table: "public.c", expected: null, actual: 0 },
    ]);
  });
});

describe("backup database name", () => {
  it("appends the UTC timestamp", () => {
    expect(backupDatabaseName("cernere", NOW)).toBe("cernere_backup_20261011_123456");
  });

  it("rejects names that are unsafe identifiers or too long", () => {
    expect(() => backupDatabaseName('cernere"; drop', NOW)).toThrow(/^site-data: invalid_config/);
    expect(() => backupDatabaseName("x".repeat(50), NOW)).toThrow(/^site-data: invalid_config/);
  });
});
