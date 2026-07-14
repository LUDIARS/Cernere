/**
 * data_sharing 定義の実施 (enforcement)
 *
 * ProjectDefinition.data_sharing (schema.ts) は「他プロジェクトからの読み取り/
 * 読み書きを許可する」ことを宣言するフィールドだが、これまでは保存されるだけで
 * 実際にどこからも参照されていなかった — 1 プロジェクトが他プロジェクトの
 * project_data_<key> を読める経路が存在しなかった。このファイルはその読み取り
 * 経路を実装する。
 *
 * 読み取りは access: "read" / "readwrite"、書き込みは "readwrite" のみ許可する。
 * module と列の範囲を解決してから既存の project data 操作へ委譲する。
 */

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as dbSchema from "../db/schema.js";
import { AppError } from "../error.js";
import type { ProjectDefinition } from "./schema.js";
import { getUserColumns, setUserData } from "./service.js";

type ColumnMap = Record<string, { type: string; module?: string; _deleted?: boolean }>;

function extractColumns(definition: ProjectDefinition | null | undefined): ColumnMap {
  return (definition?.user_data?.columns ?? {}) as ColumnMap;
}

/**
 * targetDefinition.data_sharing から、callerProjectKey が読める列名を解決する。
 * マッチする data_sharing エントリが無ければ forbidden (fail closed — 部分データを
 * 黙って返さない)。
 *
 * DB I/O を持たない純粋関数として getSharedUserColumns から分離している
 * (data_sharing の権限判定ロジック単体をユニットテストしやすくするため)。
 */
export function resolveSharedColumnNames(
  callerProjectKey: string,
  targetDefinition: ProjectDefinition,
  requestedColumns?: string[],
): string[] {
  const shares = targetDefinition.data_sharing ?? [];
  const entry = shares.find((s) =>
    s.project_key === callerProjectKey && (s.access === "read" || s.access === "readwrite"));

  if (!entry) {
    throw AppError.forbidden(
      `Project "${callerProjectKey}" has no data_sharing grant on project "${targetDefinition.project.key}"`,
    );
  }

  const columns = extractColumns(targetDefinition);
  let names = Object.keys(columns).filter((c) => !columns[c]._deleted);

  // modules 指定があれば、そのモジュールに属するカラムのみへさらに絞り込む
  // (未指定 = 全モジュール共有、schema.ts のコメント通り)。
  if (entry.modules && entry.modules.length > 0) {
    const allowedModules = new Set(entry.modules);
    names = names.filter((c) => columns[c].module !== undefined && allowedModules.has(columns[c].module as string));
  }

  // 呼び出し元が特定カラムを要求している場合はさらに絞る
  // (getUserColumns の「columns 未指定/空なら全カラム」と同じ意味論に合わせる)。
  if (requestedColumns && requestedColumns.length > 0) {
    const requestedSet = new Set(requestedColumns);
    names = names.filter((c) => requestedSet.has(c));
  }

  return names;
}

/**
 * targetDefinition が callerProjectKey に readwrite 共有している列名を解決する。
 * 読み取り専用 grant は書き込み権限へ昇格させない。
 */
export function resolveSharedWritableColumnNames(
  callerProjectKey: string,
  targetDefinition: ProjectDefinition,
  requestedColumns: string[],
): string[] {
  const entry = (targetDefinition.data_sharing ?? []).find((share) =>
    share.project_key === callerProjectKey && share.access === "readwrite");
  if (!entry) {
    throw AppError.forbidden(
      `Project "${callerProjectKey}" has no readwrite data_sharing grant on project "${targetDefinition.project.key}"`,
    );
  }

  const columns = extractColumns(targetDefinition);
  const allowedModules = entry.modules && entry.modules.length > 0
    ? new Set(entry.modules)
    : null;

  return requestedColumns.filter((columnName) => {
    const column = columns[columnName];
    if (!column || column._deleted) return false;
    if (!allowedModules) return true;
    return column.module !== undefined && allowedModules.has(column.module);
  });
}

/**
 * callerProjectKey が、targetProjectKey の data_sharing 許可範囲内で
 * そのユーザーのデータを読み取る。
 *
 * project-dispatch の managed_project.get_user_data から、payload.targetProjectKey
 * が接続中の projectKey と異なる場合にのみ呼ばれる新規経路。自分自身のデータ読み取り
 * (service.getUserColumns 直接呼び出し) の挙動は変更しない。
 */
export async function getSharedUserColumns(
  callerProjectKey: string,
  targetProjectKey: string,
  userId: string,
  columns?: string[],
): Promise<Record<string, unknown>> {
  const rows = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, targetProjectKey)).limit(1);
  if (rows.length === 0 || !rows[0].isActive) {
    throw AppError.notFound("Project not found");
  }

  const targetDefinition = rows[0].schemaDefinition as ProjectDefinition;
  const allowedColumns = resolveSharedColumnNames(callerProjectKey, targetDefinition, columns);

  if (allowedColumns.length === 0) return {};

  // 実データ取得は既存の getUserColumns (SQL) にそのまま委譲し、
  // ここでは「どのカラムを読んでよいか」の解決だけを担う。
  return getUserColumns(targetProjectKey, userId, allowedColumns);
}

/** callerProjectKey の readwrite grant 範囲内で targetProjectKey のユーザ列を更新する。 */
export async function setSharedUserColumns(
  callerProjectKey: string,
  targetProjectKey: string,
  userId: string,
  data: Record<string, unknown>,
): Promise<{ ok: true; updated: string[] }> {
  const rows = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, targetProjectKey)).limit(1);
  if (rows.length === 0 || !rows[0].isActive) {
    throw AppError.notFound("Project not found");
  }

  const requestedColumns = Object.keys(data);
  if (requestedColumns.length === 0) {
    throw AppError.badRequest("No columns to update");
  }

  const targetDefinition = rows[0].schemaDefinition as ProjectDefinition;
  const allowedColumns = resolveSharedWritableColumnNames(
    callerProjectKey,
    targetDefinition,
    requestedColumns,
  );
  if (allowedColumns.length !== requestedColumns.length) {
    const allowed = new Set(allowedColumns);
    const denied = requestedColumns.filter((columnName) => !allowed.has(columnName));
    throw AppError.forbidden(`Columns are not writable through data_sharing: ${denied.join(", ")}`);
  }

  const allowedData = Object.fromEntries(
    allowedColumns.map((columnName) => [columnName, data[columnName]]),
  );
  return setUserData(targetProjectKey, userId, allowedData);
}
