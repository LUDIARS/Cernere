/**
 * プロジェクト別 DB スキーマの動的マイグレーション
 *
 * - テーブルは CREATE TABLE IF NOT EXISTS で冪等化
 * - カラム追加も ADD COLUMN IF NOT EXISTS で冪等化
 * - カラムの DROP はしない (論理削除)
 * - 論理削除カラム (_deleted: true) は DB 上に残したままにする
 */

import postgres from "postgres";
import { config } from "../config.js";
import type { ProjectDefinition } from "./schema.js";
import { COLUMN_TYPE_MAP } from "./schema.js";

function tableNameFor(projectKey: string): string {
  return `project_data_${projectKey}`;
}

/**
 * プロジェクトのユーザーデータテーブルを作成・更新する。
 * すべての DDL は冪等 (IF NOT EXISTS) なので、再実行しても安全。
 */
export async function migrateProjectSchema(
  projectKey: string,
  definition: ProjectDefinition,
): Promise<{ created: boolean; columnsAdded: string[] }> {
  const sql = postgres(config.databaseUrl, { max: 1 });
  const tableName = tableNameFor(projectKey);
  const columns = definition.user_data?.columns ?? {};

  try {
    // CREATE TABLE IF NOT EXISTS — 冪等
    let createSql = `CREATE TABLE IF NOT EXISTS "${tableName}" (\n`;
    createSql += `  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n`;

    for (const [colName, colDef] of Object.entries(columns)) {
      if (colDef._deleted) continue; // 論理削除カラムは CREATE 時に含めない
      const pgType = COLUMN_TYPE_MAP[colDef.type] ?? "TEXT";
      const nullable = colDef.nullable !== false ? "" : " NOT NULL";
      const defaultVal = colDef.default_value ? ` DEFAULT ${escapeDefault(colDef.default_value, colDef.type)}` : "";
      createSql += `  "${colName}" ${pgType}${nullable}${defaultVal},\n`;
    }

    createSql += `  _deleted_columns JSONB NOT NULL DEFAULT '{}',\n`;
    createSql += `  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),\n`;
    createSql += `  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),\n`;
    createSql += `  PRIMARY KEY (user_id)\n`;
    createSql += `)`;

    console.log(`[schema-migrator] Ensuring table: ${tableName}`);
    await sql.unsafe(createSql);

    // ALTER TABLE ADD COLUMN IF NOT EXISTS — 冪等
    // 既存カラム検知は不要だが、どのカラムが追加されたかを返すためにチェックする
    const existingColumns = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${tableName}
    `;
    const existingSet = new Set(existingColumns.map((r) => r.column_name));

    const columnsAdded: string[] = [];
    for (const [colName, colDef] of Object.entries(columns)) {
      if (colDef._deleted) continue; // 論理削除カラムは追加しない

      const pgType = COLUMN_TYPE_MAP[colDef.type] ?? "TEXT";
      const defaultVal = colDef.default_value ? ` DEFAULT ${escapeDefault(colDef.default_value, colDef.type)}` : "";

      // IF NOT EXISTS で冪等化
      await sql.unsafe(`ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "${colName}" ${pgType}${defaultVal}`);

      if (!existingSet.has(colName)) {
        console.log(`[schema-migrator] Added column: ${tableName}.${colName} (${pgType})`);
        columnsAdded.push(colName);
      }
    }

    return { created: !existingSet.has("user_id"), columnsAdded };
  } finally {
    await sql.end();
  }
}

/**
 * 既存テーブルのカラム一覧を取得
 */
export async function getExistingColumns(projectKey: string): Promise<string[]> {
  const sql = postgres(config.databaseUrl, { max: 1 });
  const tableName = tableNameFor(projectKey);

  try {
    const rows = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${tableName}
    `;
    return rows.map((r) => r.column_name as string);
  } finally {
    await sql.end();
  }
}

function escapeDefault(value: string, type: string): string {
  if (type === "boolean") return value;
  if (type === "integer" || type === "bigint") return value;
  if (type === "json") return `'${value}'::jsonb`;
  return `'${value.replace(/'/g, "''")}'`;
}

export { tableNameFor };
