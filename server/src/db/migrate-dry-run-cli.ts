/**
 * `npm run migrate:dry-run` — 配備前の migration 事前確認。
 *
 * DATABASE_URL の DB で未適用 migration を 1 トランザクション内に実行し、
 * 必ず ROLLBACK する (COMMIT しない)。 _migrations にも記録しない。
 * 終了コード: 0 = 全て適用可能 / 1 = 失敗あり / 2 = トランザクション不可の文で停止。
 * 共有・本番 DB に向ける前に、 配備手順 (spec/setup/workload-deploy.md) を確認すること。
 */

import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { config } from "../config.js";
import { dryRunMigrations, type PendingMigration } from "./migration-dry-run.js";
import { listMigrationFiles, migrationVersion, resolveMigrationsDir, splitStatements } from "./migration-files.js";

async function appliedVersions(sql: postgres.Sql): Promise<Set<string>> {
  const [{ present }] = await sql<{ present: boolean }[]>`
    SELECT to_regclass('public._migrations') IS NOT NULL AS present
  `;
  if (!present) return new Set();
  const rows = await sql<{ version: string }[]>`SELECT version FROM _migrations`;
  return new Set(rows.map((r) => r.version));
}

function pendingMigrations(dir: string, applied: ReadonlySet<string>): PendingMigration[] {
  return listMigrationFiles(dir)
    .filter((file) => !applied.has(migrationVersion(file)))
    .map((file) => ({
      version: migrationVersion(file),
      statements: splitStatements(fs.readFileSync(path.join(dir, file), "utf-8")),
    }));
}

async function main(): Promise<number> {
  const dir = resolveMigrationsDir();
  if (!fs.existsSync(dir)) {
    console.error(`[migrate:dry-run] Migrations directory not found: ${dir}`);
    return 1;
  }
  const sql = postgres(config.databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const pending = pendingMigrations(dir, await appliedVersions(sql));
    if (pending.length === 0) {
      console.log("[migrate:dry-run] No pending migrations");
      return 0;
    }
    console.log(`[migrate:dry-run] Pending: ${pending.map((m) => m.version).join(", ")}`);
    const reserved = await sql.reserve();
    try {
      const result = await dryRunMigrations(reserved, pending);
      for (const s of result.skipped) console.log(`[migrate:dry-run]   Skipped (${s.code}) ${s.version}: ${s.statement}`);
      if (result.outcome === "blocked") {
        for (const b of result.blocked) {
          console.error(`[migrate:dry-run] Not transactional (${b.reason}) ${b.version}: ${b.statement}`);
        }
        console.error("[migrate:dry-run] Stopped without executing: these migrations cannot be rolled back as a whole");
        return 2;
      }
      if (result.failure) {
        const f = result.failure;
        console.error(`[migrate:dry-run] FAILED ${f.version} (${f.code ?? "no code"}): ${f.message}`);
        console.error(`[migrate:dry-run]   at: ${f.statement}`);
      }
      console.log(`[migrate:dry-run] Checked: ${result.checked.join(", ") || "(none)"}; rolled back: ${result.rolledBack}`);
      return result.outcome === "ok" ? 0 : 1;
    } finally {
      reserved.release();
    }
  } finally {
    await sql.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[migrate:dry-run] Error:", (err as Error).message);
    process.exit(1);
  },
);
