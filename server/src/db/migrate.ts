/**
 * マイグレーション自動実行
 *
 * migrations/ ディレクトリの SQL ファイルを番号順に実行する。
 * 適用済みのマイグレーションは _migrations テーブルで管理し、スキップする。
 */

import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { config } from "../config.js";

export async function runMigrations(): Promise<void> {
  const sql = postgres(config.databaseUrl, { max: 1 });

  try {
    // マイグレーション管理テーブルを作成
    await sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    // 適用済みバージョンを取得
    const applied = await sql<{ version: string }[]>`
      SELECT version FROM _migrations ORDER BY version
    `;
    const appliedSet = new Set(applied.map((r) => r.version));

    // migrations/ ディレクトリを探す
    // Docker: /app/migrations (volume mount)
    // ローカル: server/../migrations
    const candidates = [
      path.resolve(process.cwd(), "..", "migrations"),  // server/ の親
      path.resolve("/app", "migrations"),                // Docker mount
      path.resolve(process.cwd(), "migrations"),         // カレント直下
    ];
    const migrationsDir = candidates.find((d) => fs.existsSync(d)) ?? candidates[0];

    if (!fs.existsSync(migrationsDir)) {
      console.log(`[migrate] Migrations directory not found: ${migrationsDir}`);
      console.log("[migrate] Skipping migrations");
      return;
    }

    // SQL ファイルを番号順にソート
    const files = fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let appliedCount = 0;
    for (const file of files) {
      const version = file.replace(".sql", "");
      if (appliedSet.has(version)) continue;

      const filePath = path.join(migrationsDir, file);
      const sqlContent = fs.readFileSync(filePath, "utf-8");

      console.log(`[migrate] Applying: ${file}`);
      try {
        await sql.unsafe(sqlContent);
        await sql`INSERT INTO _migrations (version) VALUES (${version})`;
        appliedCount++;
      } catch (err) {
        console.error(`[migrate] Failed to apply ${file}:`, (err as Error).message);
        throw err;
      }
    }

    if (appliedCount > 0) {
      console.log(`[migrate] Applied ${appliedCount} migration(s)`);
    } else {
      console.log(`[migrate] All ${files.length} migrations already applied`);
    }
  } finally {
    await sql.end();
  }
}
