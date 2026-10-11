import { unlink } from "node:fs/promises";
import { assertPathAbsent, digestFile, writeBundle } from "./bundle-file.js";
import { buildBundleHeader } from "./bundle-header.js";
import type { DumpTools } from "./pg-tools.js";
import { compareRowCounts, describeMismatches } from "./row-counts.js";
import { SiteDataError } from "./site-data-error.js";
import type { SiteDatabase } from "./site-database.js";

export interface ExportDeps {
  database: SiteDatabase;
  tools: DumpTools;
  databaseName: string;
  now: () => Date;
}

export interface ExportResult {
  tables: number;
  dumpBytes: number;
}

/**
 * Logical dump of the stopped service's database into one bundle file.
 * Row counts are taken before and after the dump; a difference means something still writes,
 * so the bundle would not be a consistent picture and the export fails.
 */
export async function exportData(output: string, deps: ExportDeps): Promise<ExportResult> {
  await assertPathAbsent(output);
  const dumpPath = `${output}.pgdump.partial`;
  await assertPathAbsent(dumpPath);
  try {
    const before = await deps.database.rowCounts(deps.databaseName);
    const serverVersion = await deps.database.serverVersion();
    await deps.tools.dumpTo(dumpPath);
    const after = await deps.database.rowCounts(deps.databaseName);
    const changed = compareRowCounts(before, after);
    if (changed.length) throw new SiteDataError("database_changed", describeMismatches(changed));
    const dump = await digestFile(dumpPath);
    const header = buildBundleHeader({
      createdAt: deps.now(), serverVersion, database: deps.databaseName,
      tables: before, dumpSha256: dump.sha256, dumpBytes: dump.bytes,
    });
    await writeBundle(output, header, dumpPath);
    return { tables: Object.keys(before).length, dumpBytes: dump.bytes };
  } finally {
    await unlink(dumpPath).catch(() => undefined);
  }
}
