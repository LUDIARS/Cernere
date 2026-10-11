import { assertRegularFile, digestFile, readBundlePreamble } from "./bundle-file.js";
import { validateBundleHeader } from "./bundle-header.js";
import type { DumpTools } from "./pg-tools.js";
import { restoreDatabase, type RestoreResult } from "./restore-procedure.js";
import { SiteDataError } from "./site-data-error.js";
import type { SiteDatabase } from "./site-database.js";

export interface ImportDeps {
  database: SiteDatabase;
  tools: DumpTools;
  databaseName: string;
  now: () => Date;
}

export interface ImportResult extends RestoreResult {
  tables: number;
}

/** Every identity and integrity check finishes before the first database change. */
export async function importData(input: string, expectedSha256: string, deps: ImportDeps): Promise<ImportResult> {
  await assertRegularFile(input);
  if ((await digestFile(input)).sha256 !== expectedSha256) throw new SiteDataError("sha256_mismatch");
  const { header: raw, dumpOffset } = await readBundlePreamble(input);
  const header = validateBundleHeader(raw);
  const dump = await digestFile(input, dumpOffset);
  if (dump.sha256 !== header.dump.sha256 || dump.bytes !== header.dump.bytes) {
    throw new SiteDataError("dump_sha256_mismatch");
  }
  const result = await restoreDatabase(
    { database: deps.databaseName, source: { path: input, start: dumpOffset }, expectedCounts: header.tables },
    deps,
  );
  return { ...result, tables: Object.keys(header.tables).length };
}
