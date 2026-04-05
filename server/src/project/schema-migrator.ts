/**
 * プロジェクト別 DB スキーマの動的マイグレーション
 *
 * - テーブルの CREATE IF NOT EXISTS
 * - カラムの ADD (既存はスキップ)
 * - カラムの DROP はしない (論理削除)
 */

import postgres from "postgres";
import { config } from "../config.js";
import type { ProjectDefinition } from "./schema.js";
import { COLUMN_TYPE_MAP } from "./schema.js";

function tableNameFor(projectKey: string): string {
  return `project_data_${projectKey}`;
}

/**
 * プロジェクトのユーザーデータテーブルを作成・更新する
 */
export async function migrateProjectSchema(
  projectKey: string,
  definition: ProjectDefinition,
): Promise<{ created: boolean; columnsAdded: string[] }> {
  const sql = postgres(config.databaseUrl, { max: 1 });
  const tableName = tableNameFor(projectKey);
  const columns = definition.user_data?.columns ?? {};

  try {
    // テーブル存在チェック
    const tableExists = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${tableName}
      ) AS exists
    `;
    const exists = tableExists[0]?.exists === true;

    if (!exists) {
      // テーブル作成
      let createSql = `CREATE TABLE "${tableName}" (\n`;
      createSql += `  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n`;

      for (const [colName, colDef] of Object.entries(columns)) {
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

      console.log(`[schema-migrator] Creating table: ${tableName}`);
      await sql.unsafe(createSql);

      return { created: true, columnsAdded: Object.keys(columns) };
    }

    // 既存テーブル: カラム追加のみ
    const existingColumns = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${tableName}
    `;
    const existingSet = new Set(existingColumns.map((r) => r.column_name));

    const columnsAdded: string[] = [];
    for (const [colName, colDef] of Object.entries(columns)) {
      if (existingSet.has(colName)) continue;

      const pgType = COLUMN_TYPE_MAP[colDef.type] ?? "TEXT";
      const defaultVal = colDef.default_value ? ` DEFAULT ${escapeDefault(colDef.default_value, colDef.type)}` : "";

      console.log(`[schema-migrator] Adding column: ${tableName}.${colName} (${pgType})`);
      await sql.unsafe(`ALTER TABLE "${tableName}" ADD COLUMN "${colName}" ${pgType}${defaultVal}`);
      columnsAdded.push(colName);
    }

    return { created: false, columnsAdded };
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
