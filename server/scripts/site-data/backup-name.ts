import { contract } from "@ludiars/log-weaver";
import backupNameContract from "./contracts/backup-name.contract.js";
import { assertDatabaseName } from "./identifiers.js";

/** `cernere` + 2026-10-11T12:34:56.789Z → `cernere_backup_20261011_123456` (UTC). */
export function utcStamp(now: Date): string {
  return now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_");
}

function makeBackupDatabaseName(database: string, now: Date): string {
  const stamp = utcStamp(now);
  return assertDatabaseName(`${assertDatabaseName(database)}_backup_${stamp}`);
}

export const backupDatabaseName = contract(makeBackupDatabaseName, {
  ...backupNameContract, contractId: "C-22", mode: "observe", sample: 1,
  where: "server/scripts/site-data/backup-name.ts", rule: "contract-wrap", id: "backup-name",
});
