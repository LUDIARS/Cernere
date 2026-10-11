import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUNDLE_MAGIC } from "../../scripts/site-data/bundle-file.js";
import { exportData } from "../../scripts/site-data/export-data.js";
import { importData } from "../../scripts/site-data/import-data.js";
import { COUNTS, DUMP, FakeDatabase, FakeTools, NOW, tempDir } from "./fakes.js";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const BACKUP = "cernere_backup_20261011_123456";

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => { ({ dir, cleanup } = await tempDir()); });
afterEach(async () => { await cleanup(); });

function source() {
  const db = new FakeDatabase();
  db.databases.set("cernere", COUNTS);
  return { db, deps: { database: db, tools: new FakeTools(db), databaseName: "cernere", now: () => NOW } };
}

async function exportBundle(): Promise<{ path: string; hash: string }> {
  const path = join(dir, "cernere-20261011.bundle");
  await exportData(path, source().deps);
  return { path, hash: sha256(await readFile(path)) };
}

function destination(existing: boolean) {
  const db = new FakeDatabase();
  if (existing) db.databases.set("cernere", { "public.users": 1 });
  const tools = new FakeTools(db);
  return { db, tools, deps: { database: db, tools, databaseName: "cernere", now: () => NOW } };
}

describe("data export", () => {
  it("writes the header and the dump into one bundle and removes the work file", async () => {
    const { path } = await exportBundle();
    const bytes = await readFile(path);
    const [magic, headerLine] = bytes.toString("latin1").split("\n", 2);
    expect(magic).toBe(BUNDLE_MAGIC);
    expect(JSON.parse(headerLine)).toMatchObject({
      service: "cernere", formatVersion: 1, tables: COUNTS, excluded: ["redis"],
      dump: { sha256: sha256(DUMP), bytes: DUMP.length },
    });
    expect(bytes.subarray(magic.length + headerLine.length + 2)).toEqual(DUMP);
    expect(await readdir(dir)).toEqual(["cernere-20261011.bundle"]);
  });

  it("refuses an existing output without touching the database", async () => {
    const path = join(dir, "taken.bundle");
    await writeFile(path, "previous");
    const { db, deps } = source();
    await expect(exportData(path, deps)).rejects.toThrow(/^site-data: output_exists/);
    expect(db.calls).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("previous");
  });

  it("fails when rows change during the dump and leaves no output", async () => {
    const { db, deps } = source();
    db.countsSequence = [COUNTS, { ...COUNTS, "public.users": 4 }];
    await expect(exportData(join(dir, "x.bundle"), deps))
      .rejects.toThrow(/^site-data: database_changed \(public\.users: 3 -> 4\)/);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("data import", () => {
  it("verifies, preserves the existing database, restores and checks row counts", async () => {
    const { path, hash } = await exportBundle();
    const { db, tools, deps } = destination(true);
    expect(await importData(path, hash, deps)).toEqual({ backup: BACKUP, tables: 2 });
    expect(db.calls).toEqual([
      "exists cernere", `exists ${BACKUP}`, `rename cernere->${BACKUP}`,
      "create cernere", "restore cernere", "counts cernere",
    ]);
    expect(tools.restored).toEqual(DUMP);
    expect(db.databases.get(BACKUP)).toEqual({ "public.users": 1 });
  });

  it("restores without a backup when the database does not exist", async () => {
    const { path, hash } = await exportBundle();
    const { db, deps } = destination(false);
    expect(await importData(path, hash, deps)).toEqual({ backup: null, tables: 2 });
    expect(db.calls).toEqual(["exists cernere", "create cernere", "restore cernere", "counts cernere"]);
  });

  it("rejects a hash mismatch before any database call", async () => {
    const { path } = await exportBundle();
    const { db, deps } = destination(true);
    await expect(importData(path, "0".repeat(64), deps)).rejects.toThrow(/^site-data: sha256_mismatch/);
    expect(db.calls).toEqual([]);
  });

  it("rejects another service's bundle and a tampered dump before any database call", async () => {
    const { path } = await exportBundle();
    const text = (await readFile(path)).toString("latin1");
    const foreign = join(dir, "foreign.bundle");
    await writeFile(foreign, Buffer.from(text.replace("\"service\":\"cernere\"", "\"service\":\"glab\""), "latin1"));
    const tampered = join(dir, "tampered.bundle");
    await writeFile(tampered, Buffer.from(text.replace("fixture-custom", "fixture-CUSTOM"), "latin1"));
    const cases: Array<[string, RegExp]> = [[foreign, /^site-data: service_mismatch/], [tampered, /^site-data: dump_sha256_mismatch/]];
    for (const [file, error] of cases) {
      const { db, deps } = destination(true);
      await expect(importData(file, sha256(await readFile(file)), deps)).rejects.toThrow(error);
      expect(db.calls).toEqual([]);
    }
  });

  it("rejects a file that is not a bundle and a non-file input", async () => {
    const file = join(dir, "plain.bin");
    await writeFile(file, "not a bundle");
    const { deps } = destination(false);
    await expect(importData(file, sha256(Buffer.from("not a bundle")), deps)).rejects.toThrow(/^site-data: bundle_invalid/);
    await expect(importData(dir, "0".repeat(64), deps)).rejects.toThrow(/^site-data: input_invalid/);
  });

  it("drops the new database and renames the backup back when row counts differ", async () => {
    const { path, hash } = await exportBundle();
    const { db, tools, deps } = destination(true);
    tools.restoreCounts = { "public.users": 3 };
    await expect(importData(path, hash, deps))
      .rejects.toThrow(/^site-data: row_count_mismatch \(public\._migrations: 40 -> absent\)/);
    expect(db.calls.slice(-2)).toEqual(["drop cernere", `rename ${BACKUP}->cernere`]);
    expect([...db.databases]).toEqual([["cernere", { "public.users": 1 }]]);
  });

  it("drops only the new database when pg_restore fails and nothing existed", async () => {
    const { path, hash } = await exportBundle();
    const { db, tools, deps } = destination(false);
    tools.failRestore = true;
    await expect(importData(path, hash, deps)).rejects.toThrow("fixture pg_restore failure");
    expect(db.calls.slice(-1)).toEqual(["drop cernere"]);
    expect(db.databases.size).toBe(0);
  });

  it("keeps the backup and reports its name when the rollback itself fails", async () => {
    const { path, hash } = await exportBundle();
    const { db, tools, deps } = destination(true);
    tools.failRestore = true;
    db.failOn.add("drop");
    await expect(importData(path, hash, deps))
      .rejects.toThrow(`site-data: rollback_failed (previous data is preserved as ${BACKUP})`);
    expect(db.databases.has(BACKUP)).toBe(true);
  });

  it("does not rename or create anything when the backup name is already taken", async () => {
    const { path, hash } = await exportBundle();
    const { db, deps } = destination(true);
    db.databases.set(BACKUP, {});
    await expect(importData(path, hash, deps)).rejects.toThrow(/^site-data: restore_failed/);
    expect(db.calls.some((call) => call.startsWith("rename") || call.startsWith("create"))).toBe(false);
  });
});
