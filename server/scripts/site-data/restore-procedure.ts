import { backupDatabaseName } from "./backup-name.js";
import type { ByteRange } from "./bundle-file.js";
import type { DumpTools } from "./pg-tools.js";
import { compareRowCounts, describeMismatches, type RowCounts } from "./row-counts.js";
import { SiteDataError } from "./site-data-error.js";
import type { SiteDatabase } from "./site-database.js";

export interface RestorePlan {
  database: string;
  source: ByteRange;
  expectedCounts: RowCounts;
}

export interface RestoreDeps {
  database: SiteDatabase;
  tools: DumpTools;
  now: () => Date;
}

export interface RestoreResult {
  /** Name the previous database was preserved under, or null when there was none. */
  backup: string | null;
}

/**
 * Service-owned restore: keep any existing database under `<name>_backup_<UTC>`, restore into a
 * fresh database and verify per-table row counts. On failure the new database is dropped and the
 * backup is renamed back, so the site returns to its previous state. Backups are never deleted here.
 */
export async function restoreDatabase(plan: RestorePlan, deps: RestoreDeps): Promise<RestoreResult> {
  const { database: db } = deps;
  let backup: string | null = null;
  if (await db.databaseExists(plan.database)) {
    backup = backupDatabaseName(plan.database, deps.now());
    if (await db.databaseExists(backup)) throw new SiteDataError("restore_failed", "backup name already in use");
    await db.renameDatabase(plan.database, backup);
  }
  let created = false;
  try {
    await db.createDatabase(plan.database);
    created = true;
    await deps.tools.restoreFrom(plan.database, plan.source);
    const mismatches = compareRowCounts(plan.expectedCounts, await db.rowCounts(plan.database));
    if (mismatches.length) throw new SiteDataError("row_count_mismatch", describeMismatches(mismatches));
    return { backup };
  } catch (error) {
    await rollBack(db, plan.database, backup, created);
    throw error;
  }
}

async function rollBack(db: SiteDatabase, database: string, backup: string | null, created: boolean): Promise<void> {
  try {
    if (created) await db.dropDatabase(database);
    if (backup) await db.renameDatabase(backup, database);
  } catch {
    throw new SiteDataError("rollback_failed", backup ? `previous data is preserved as ${backup}` : "restored database left in place");
  }
}
