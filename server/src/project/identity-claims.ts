/**
 * identity claim の開示 — users 側 identity 列をプロジェクトへ渡す唯一の経路。
 *
 * `discord_id` のような識別子は project_data_<key> ではなく users 行にあるため、
 * user_data.columns の宣言では届かない。かといって profile.get に足すと全プロジェクト
 * へ無条件開示になる。そこで managed_projects.schema_definition の
 * `identity_claims` (管理者所有) を唯一の判定材料にする。
 *
 * **Cernere は呼び出し元が何のサービスかを知らない。** 「glab なら許す」ではなく
 * 「宣言があるなら許す」で解決する。未宣言は fail-closed で拒否する
 * (無言の空返却にすると設定不備が発見されないため — RULE §7.1)。
 */

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as dbSchema from "../db/schema.js";
import { config } from "../config.js";
import { AppError } from "../error.js";
import { IDENTITY_CLAIMS, type IdentityClaim, type ProjectDefinition } from "./schema.js";

const CLAIM_SET: ReadonlySet<string> = new Set(IDENTITY_CLAIMS);

export function isIdentityClaim(value: string): value is IdentityClaim {
  return CLAIM_SET.has(value);
}

/**
 * プロジェクトが開示を許可されている claim 一覧を返す。
 * 定義に無い / 許可リスト外の値は落とす (定義側の誤りで開示範囲が広がらないように)。
 */
export async function loadDeclaredClaims(projectKey: string): Promise<IdentityClaim[]> {
  const rows = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, projectKey)).limit(1);
  if (rows.length === 0) throw AppError.notFound("Project not found");

  const definition = rows[0].schemaDefinition as ProjectDefinition | null;
  const declared = (definition as { identity_claims?: unknown } | null)?.identity_claims;
  if (!Array.isArray(declared)) return [];

  return declared.filter((c): c is IdentityClaim => typeof c === "string" && isIdentityClaim(c));
}

/**
 * 要求された claim を宣言済みのものだけに絞る。
 * 宣言が空、または要求が全て未宣言なら throw する (fail-closed)。
 */
async function resolveRequestedClaims(
  projectKey: string,
  requested?: string[],
): Promise<IdentityClaim[]> {
  const declared = await loadDeclaredClaims(projectKey);
  if (declared.length === 0) {
    throw AppError.forbidden(`Project "${projectKey}" declares no identity_claims`);
  }
  if (!requested || requested.length === 0) return declared;

  const allowed = requested.filter((c): c is IdentityClaim => isIdentityClaim(c) && declared.includes(c));
  if (allowed.length === 0) {
    throw AppError.forbidden(`Requested identity claims are not declared by project "${projectKey}"`);
  }
  return allowed;
}

/** 指定ユーザの、宣言済み claim のみを返す。 */
export async function getIdentityClaims(
  projectKey: string,
  userId: string,
  requested?: string[],
): Promise<Record<string, unknown>> {
  const claims = await resolveRequestedClaims(projectKey, requested);

  // claims は許可リスト由来の固定文字列なので識別子として安全。
  const selectCols = claims.map((c) => `"${c}"`).join(", ");
  const { default: postgres } = await import("postgres");
  const sqlClient = postgres(config.databaseUrl, { max: 1 });
  try {
    const rows = await sqlClient.unsafe(
      `SELECT ${selectCols} FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    const result: Record<string, unknown> = {};
    for (const c of claims) result[c] = rows[0]?.[c] ?? null;
    return result;
  } finally {
    await sqlClient.end();
  }
}

/**
 * claim の値からユーザを逆引きする (bot が Discord ID で照会する用途)。
 * 宣言していない claim では引けない。
 */
export async function resolveUserByClaim(
  projectKey: string,
  claim: string,
  value: string,
): Promise<{ userId: string; displayName: string } | null> {
  const [allowed] = await resolveRequestedClaims(projectKey, [claim]);

  const { default: postgres } = await import("postgres");
  const sqlClient = postgres(config.databaseUrl, { max: 1 });
  try {
    const rows = await sqlClient.unsafe(
      `SELECT id AS "userId", display_name AS "displayName" FROM users WHERE "${allowed}" = $1 LIMIT 1`,
      [value],
    );
    return (rows[0] as unknown as { userId: string; displayName: string } | undefined) ?? null;
  } finally {
    await sqlClient.end();
  }
}
