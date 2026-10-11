import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ByteRange } from "../../scripts/site-data/bundle-file.js";
import type { DumpTools } from "../../scripts/site-data/pg-tools.js";
import type { RowCounts } from "../../scripts/site-data/row-counts.js";
import type { SiteDatabase } from "../../scripts/site-data/site-database.js";

export const DUMP = Buffer.from("PGDMP\u0000fixture-custom-archive\nÿ\u0001tail");
export const COUNTS: RowCounts = { "public.users": 3, "public._migrations": 40 };
export const NOW = new Date("2026-10-11T12:34:56.789Z");

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cernere-site-data-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** In-memory Postgres server: databases map to their row counts. Every call is logged in order. */
export class FakeDatabase implements SiteDatabase {
  readonly calls: string[] = [];
  readonly databases = new Map<string, RowCounts>();
  countsSequence: RowCounts[] = [];
  failOn = new Set<string>();

  private step(name: string): void {
    this.calls.push(name);
    if (this.failOn.has(name.split(" ")[0])) throw new Error(`fixture failure ${name}`);
  }
  async serverVersion() { this.step("version"); return "17.9"; }
  async rowCounts(database: string) {
    this.step(`counts ${database}`);
    return this.countsSequence.shift() ?? this.databases.get(database) ?? {};
  }
  async databaseExists(name: string) { this.calls.push(`exists ${name}`); return this.databases.has(name); }
  async renameDatabase(from: string, to: string) {
    this.step(`rename ${from}->${to}`);
    this.databases.set(to, this.databases.get(from)!);
    this.databases.delete(from);
  }
  async createDatabase(name: string) { this.step(`create ${name}`); this.databases.set(name, {}); }
  async dropDatabase(name: string) { this.step(`drop ${name}`); this.databases.delete(name); }
}

export class FakeTools implements DumpTools {
  restored: Buffer | null = null;
  restoreCounts: RowCounts = COUNTS;
  failRestore = false;
  constructor(private readonly db: FakeDatabase) {}

  async dumpTo(path: string) {
    this.db.calls.push("dump");
    await writeFile(path, DUMP, { flag: "wx" });
  }
  async restoreFrom(database: string, source: ByteRange) {
    this.db.calls.push(`restore ${database}`);
    const chunks: Buffer[] = [];
    for await (const chunk of createReadStream(source.path, { start: source.start })) chunks.push(chunk as Buffer);
    this.restored = Buffer.concat(chunks);
    if (this.failRestore) throw new Error("fixture pg_restore failure");
    this.db.databases.set(database, this.restoreCounts);
  }
}
