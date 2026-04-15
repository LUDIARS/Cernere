/**
 * マイグレーション自動実行
 *
 * migrations/ ディレクトリの SQL ファイルを番号順に実行する。
 * 適用済みのマイグレーションは _migrations テーブルで管理し、スキップする。
 *
 * Rust (sqlx) からの移行:
 *   _sqlx_migrations テーブルが存在する場合、適用済みバージョンを
 *   _migrations にコピーして既存 SQL の再実行を防ぐ。
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

    // Rust (sqlx) からの移行: _sqlx_migrations があれば適用済みをコピー
    await importFromSqlx(sql);

    // 適用済みバージョンを取得
    const applied = await sql<{ version: string }[]>`
      SELECT version FROM _migrations ORDER BY version
    `;
    const appliedSet = new Set(applied.map((r) => r.version));

    // migrations/ ディレクトリを探す
    const candidates = [
      path.resolve(process.cwd(), "..", "migrations"),
      path.resolve("/app", "migrations"),
      path.resolve(process.cwd(), "migrations"),
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
      if (appliedSet.has(version)) {
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      const sqlContent = fs.readFileSync(filePath, "utf-8");

      console.log(`[migrate] Applying: ${file}`);
      try {
        // 各ステートメントを個別実行（エラー耐性のため）
        const statements = splitStatements(sqlContent);
        for (const stmt of statements) {
          try {
            await sql.unsafe(stmt);
          } catch (err) {
            const code = (err as { code?: string }).code;
            // 「既に存在する」系のエラーはスキップして続行 (冪等運用)
            // 42P01 (relation does not exist) 等、構造不整合のエラーはスキップしない
            //   — テーブル未作成を隠蔽するとデータ破損の原因になるため
            const ignorable = new Set([
              "42P07",  // duplicate_table (relation already exists)
              "42701",  // duplicate_column
              "42710",  // duplicate_object (index, type, etc.)
              "42P06",  // duplicate_schema
              "42P04",  // duplicate_database
              "23505",  // unique_violation (duplicate key)
              "42P16",  // invalid_table_definition (PK すでにある等、冪等ケース)
            ]);
            if (code && ignorable.has(code)) {
              console.log(`[migrate]   Skipped (${code}): ${stmt.slice(0, 80)}...`);
              continue;
            }
            throw err;
          }
        }
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

/**
 * _sqlx_migrations テーブルから既存の適用済みバージョンをインポート
 */
async function importFromSqlx(sql: postgres.Sql): Promise<void> {
  try {
    const exists = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = '_sqlx_migrations'
      ) AS exists
    `;

    if (!exists[0]?.exists) return;

    // _sqlx_migrations からバージョンを取得 (version は bigint)
    const sqlxMigrations = await sql<{ version: string; description: string }[]>`
      SELECT version::text, description FROM _sqlx_migrations ORDER BY version
    `;

    if (sqlxMigrations.length === 0) return;

    // 既に _migrations にあるものを除外
    const existing = await sql<{ version: string }[]>`
      SELECT version FROM _migrations
    `;
    const existingSet = new Set(existing.map((r) => r.version));

    // sqlx のバージョン番号 (例: 1, 2, 3) をファイル名ベース (例: 001_initial) にマッピング
    // description からファイル名を推測
    let imported = 0;
    for (const m of sqlxMigrations) {
      // description は通常 "initial", "google auth and password" のような形式
      // version番号からファイルプレフィックスを生成
      const prefix = m.version.padStart(3, "0");
      const version = `${prefix}_${m.description.replace(/\s+/g, "_").toLowerCase()}`;

      if (existingSet.has(version)) continue;

      await sql`INSERT INTO _migrations (version) VALUES (${version}) ON CONFLICT DO NOTHING`;
      imported++;
    }

    if (imported > 0) {
      console.log(`[migrate] Imported ${imported} version(s) from _sqlx_migrations`);
    }
  } catch {
    // _sqlx_migrations が存在しない場合やエラーは無視
  }
}

/**
 * SQL テキストをステートメントに分割
 *
 * - `;` で分割
 * - 各ステートメント先頭の `-- コメント行` を除去 (trim 後の最初の非空行が
 *   コメントだったら読み飛ばす)
 * - 実行可能な本体が残らなければステートメントとして扱わない
 */
function splitStatements(sqlText: string): string[] {
  return sqlText
    .split(";")
    .map(stripLeadingComments)
    .filter((s) => s.length > 0);
}

/** ステートメント先頭の `-- コメント行` と空行を除去 */
function stripLeadingComments(raw: string): string {
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("--")) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join("\n").trim();
}
