/**
 * 本人の行 (`project_data_<storage_slug>`) の入力項目の読み書き (設計書 §3 / §5)。
 *
 * SQL 識別子 (表名・列名) は、宣言と列定義を照合した後の値 (呼び出し側が SignupFieldView から渡す) だけを
 * sql.identifier で引用して使う。値は常にパラメータ。
 * 行が無ければ作る (ensureUserProjectRow と同じ ON CONFLICT (user_id)) — 同意の保存と同じ
 * トランザクションに載せるため、別接続の ensureUserProjectRow ではなく upsert 1 文で行う。
 */

import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/connection.js";
import { consentServiceId, deniedPermissionKeys } from "../consent/denials.js";
import type { ConsentSubject, ConsentTransaction } from "../consent/store.js";
import type { SignupTableGroup } from "./targets.js";
import type { SignupValue } from "./values.js";

const MODULE_PERMISSION_PREFIX = "user_data.module:";

type Executor = Pick<typeof db, "execute"> | ConsentTransaction;

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [];
}

function columnList(columns: readonly string[]): SQL {
  return sql.join(columns.map((c) => sql.identifier(c)), sql`, `);
}

/** 同意で拒否された user_data の module (user_data_optouts の module:<m>)。 */
export async function deniedSignupModules(userId: string, subject: ConsentSubject): Promise<Set<string>> {
  const keys = await deniedPermissionKeys(userId, consentServiceId(subject));
  const modules = new Set<string>();
  for (const key of keys) {
    if (key.startsWith(MODULE_PERMISSION_PREFIX)) modules.add(key.slice(MODULE_PERMISSION_PREFIX.length));
  }
  return modules;
}

/** 本人の行から指定列の値を読む。行が無ければ {}。 */
export async function loadSignupValues(
  tableName: string,
  userId: string,
  columns: readonly string[],
): Promise<Record<string, unknown>> {
  if (columns.length === 0) return {};
  const result = await db.execute(sql`SELECT ${columnList(columns)} FROM ${sql.identifier(tableName)} WHERE user_id = ${userId} LIMIT 1`);
  return rowsOf(result)[0] ?? {};
}

/** 値を書く (行が無ければ作る)。values のキーは検証済みの列名だけ。 */
export async function writeSignupValues(
  executor: Executor,
  tableName: string,
  userId: string,
  values: Readonly<Record<string, SignupValue>>,
): Promise<void> {
  const columns = Object.keys(values);
  if (columns.length === 0) {
    await executor.execute(sql`INSERT INTO ${sql.identifier(tableName)} (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`);
    return;
  }
  const params = sql.join(columns.map((c) => sql`${values[c]}`), sql`, `);
  const updates = sql.join([
    ...columns.map((c) => sql`${sql.identifier(c)} = EXCLUDED.${sql.identifier(c)}`),
    sql`updated_at = now()`,
  ], sql`, `);
  await executor.execute(sql`INSERT INTO ${sql.identifier(tableName)} (user_id, ${columnList(columns)}) VALUES (${userId}, ${params})
    ON CONFLICT (user_id) DO UPDATE SET ${updates}`);
}

/** 保存先表ごとに書く (同じ executor = 同じトランザクション)。groups は targets.ts の valuesByTable。 */
export async function writeSignupValueGroups(
  executor: Executor,
  userId: string,
  groups: ReadonlyArray<SignupTableGroup<SignupValue>>,
): Promise<void> {
  for (const group of groups) await writeSignupValues(executor, group.table, userId, group.values);
}
