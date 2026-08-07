/**
 * project_data_<key> の横断検索 — 「条件に合うユーザを列挙する」汎用クエリ。
 *
 * 既存の get_user_data は userId を指定した 1 行取得しかできない。「今この列が
 * true のユーザ全員」を取るには行をまたぐ検索が要る。これをサービスごとの専用
 * コマンドで足すと Cernere が個々のサービスを知ることになるため、宣言済みカラムに
 * 対する汎用述語として実装する。
 *
 * 述語は 2 種類だけ:
 *   - `where`      宣言済みカラムの等値比較
 *   - `activeAt`   timestamp カラムの「未失効」判定 (NULL = 無期限)
 *
 * どちらも **宣言済みカラムしか受け付けない**。未宣言の列名は無言で無視せず throw
 * する (設定不備を発見できなくなるため)。identity claim を混ぜる場合も
 * identity-claims.ts の宣言検査を通す。
 */

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as dbSchema from "../db/schema.js";
import { config } from "../config.js";
import { AppError } from "../error.js";
import { assertSafeIdentifier } from "./identifier.js";
import { loadDeclaredClaims, isIdentityClaim } from "./identity-claims.js";
import type { ProjectDefinition } from "./schema.js";

export interface ListUserDataInput {
  /** 返す project_data 列。省略時は宣言済みの全アクティブ列。 */
  columns?: string[];
  /** 宣言済み列に対する等値条件 (AND)。 */
  where?: Record<string, string | number | boolean | null>;
  /** `{column}` が NULL または指定時刻より後 = 未失効、で絞る。 */
  activeAt?: { column: string; at?: string };
  /** 併せて返す identity claim (identity_claims の宣言が必要)。 */
  claims?: string[];
  /** 返却上限 (既定 200、上限 1000)。 */
  limit?: number;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function tableNameFor(projectKey: string): string {
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(projectKey)) {
    throw AppError.badRequest("Invalid project key");
  }
  return `project_data_${projectKey}`;
}

async function loadActiveColumns(
  projectKey: string,
): Promise<Record<string, { type: string; _deleted?: boolean }>> {
  const rows = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, projectKey)).limit(1);
  if (rows.length === 0) throw AppError.notFound("Project not found");

  const definition = rows[0].schemaDefinition as ProjectDefinition | null;
  const all = (definition?.user_data?.columns ?? {}) as Record<string, { type: string; _deleted?: boolean }>;

  const active: Record<string, { type: string; _deleted?: boolean }> = {};
  for (const [name, def] of Object.entries(all)) {
    if (!def._deleted) active[name] = def;
  }
  return active;
}

/** 宣言済みかを検査する。未宣言なら throw (無言スキップしない)。 */
function assertDeclared(
  column: string,
  active: Record<string, { type: string }>,
  projectKey: string,
): void {
  if (!(column in active)) {
    throw AppError.badRequest(`Column "${column}" is not declared by project "${projectKey}"`);
  }
  assertSafeIdentifier(column, "column");
}

export async function listUserData(
  projectKey: string,
  input: ListUserDataInput = {},
): Promise<Array<Record<string, unknown>>> {
  validateInput(input);
  const table = tableNameFor(projectKey);
  const active = await loadActiveColumns(projectKey);

  const selectCols = (input.columns && input.columns.length > 0)
    ? input.columns
    : Object.keys(active);
  for (const c of selectCols) assertDeclared(c, active, projectKey);
  if (selectCols.length === 0) return [];

  // identity claim は users 側。宣言検査を identity-claims.ts に委ねる。
  let claims: string[] = [];
  if (input.claims && input.claims.length > 0) {
    const declared = await loadDeclaredClaims(projectKey);
    for (const c of input.claims) {
      if (!isIdentityClaim(c) || !declared.includes(c)) {
        throw AppError.forbidden(`Identity claim "${c}" is not declared by project "${projectKey}"`);
      }
    }
    claims = input.claims;
  }

  const params: Array<string | number | boolean> = [];
  const conditions: string[] = [];

  for (const [column, value] of Object.entries(input.where ?? {})) {
    assertDeclared(column, active, projectKey);
    if (value === null) {
      conditions.push(`d."${column}" IS NULL`);
    } else {
      params.push(value);
      conditions.push(`d."${column}" = $${params.length}`);
    }
  }

  if (input.activeAt) {
    const { column, at } = input.activeAt;
    assertDeclared(column, active, projectKey);
    if (active[column].type !== "timestamp") {
      throw AppError.badRequest(`activeAt requires a timestamp column, got "${column}"`);
    }
    if (at) {
      params.push(at);
      conditions.push(`(d."${column}" IS NULL OR d."${column}" > $${params.length}::timestamptz)`);
    } else {
      conditions.push(`(d."${column}" IS NULL OR d."${column}" > now())`);
    }
  }

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const projected = [
    `d.user_id AS "userId"`,
    `u.display_name AS "displayName"`,
    ...selectCols.map((c) => `d."${c}"`),
    ...claims.map((c) => `u."${c}"`),
  ].join(", ");

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const { default: postgres } = await import("postgres");
  const sqlClient = postgres(config.databaseUrl, { max: 1 });
  try {
    const rows = await sqlClient.unsafe(
      `SELECT ${projected} FROM "${table}" d JOIN users u ON u.id = d.user_id ${whereSql} LIMIT ${limit}`,
      params,
    );
    return rows as unknown as Array<Record<string, unknown>>;
  } finally {
    await sqlClient.end();
  }
}

function validateInput(input: unknown): asserts input is ListUserDataInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw AppError.badRequest("input must be an object");
  }
  const value = input as Record<string, unknown>;

  for (const field of ["columns", "claims"] as const) {
    const items = value[field];
    if (items !== undefined
      && (!Array.isArray(items) || items.some((item) => typeof item !== "string"))) {
      throw AppError.badRequest(`${field} must be an array of strings`);
    }
  }

  if (value.where !== undefined) {
    if (!value.where || typeof value.where !== "object" || Array.isArray(value.where)) {
      throw AppError.badRequest("where must be an object");
    }
    for (const condition of Object.values(value.where as Record<string, unknown>)) {
      if (condition !== null && typeof condition !== "string"
        && typeof condition !== "number" && typeof condition !== "boolean") {
        throw AppError.badRequest("where values must be string, number, boolean, or null");
      }
      if (typeof condition === "number" && !Number.isFinite(condition)) {
        throw AppError.badRequest("where numeric values must be finite");
      }
    }
  }

  if (value.activeAt !== undefined) {
    if (!value.activeAt || typeof value.activeAt !== "object" || Array.isArray(value.activeAt)) {
      throw AppError.badRequest("activeAt must be an object");
    }
    const activeAt = value.activeAt as Record<string, unknown>;
    if (typeof activeAt.column !== "string" || activeAt.column.length === 0) {
      throw AppError.badRequest("activeAt.column is required");
    }
    if (activeAt.at !== undefined
      && (typeof activeAt.at !== "string" || Number.isNaN(Date.parse(activeAt.at)))) {
      throw AppError.badRequest("activeAt.at must be a valid timestamp");
    }
  }

  if (value.limit !== undefined
    && (typeof value.limit !== "number" || !Number.isInteger(value.limit))) {
    throw AppError.badRequest("limit must be an integer");
  }
}
