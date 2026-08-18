/**
 * storage slug — project key から切り離した不変の SQL 識別子。
 *
 * project key は「人が読むラベル」であり、`project_data_<...>` の表名を決めない。
 * 表名を決めるのは managed_projects.storage_slug だけで、値は発行時に固定し二度と変えない
 * (Corpus spec/plan/auth-plane-consolidation.md §4.4、migration 043)。
 *
 * このモジュールは純粋関数のみ (DB を触らない)。DB から slug を引くのは
 * storage-resolver.ts。
 */

import { assertSafeIdentifier } from "./identifier.js";

/** `project_data_` (13 文字) + slug が PostgreSQL の識別子上限 63 に収まる長さ。 */
export const MAX_STORAGE_SLUG_LENGTH = 50;

/** 小文字英字始まり、英数字とアンダースコアのみ、2〜50 文字。migration 043 の CHECK と同じ。 */
export const STORAGE_SLUG_REGEX = /^[a-z][a-z0-9_]{1,49}$/;

const TABLE_PREFIX = "project_data_";

/** storage slug として妥当か検証する。不正なら throw (無言で通さない)。 */
export function assertStorageSlug(slug: unknown): asserts slug is string {
  if (typeof slug !== "string" || !STORAGE_SLUG_REGEX.test(slug)) {
    throw new Error(
      `invalid storage slug ${JSON.stringify(slug)}: must match ${STORAGE_SLUG_REGEX.source}`,
    );
  }
}

/** 検証済み slug から `project_data_<slug>` を組み立てる。補間直前に必ず通す。 */
export function storageTableName(slug: unknown): string {
  assertStorageSlug(slug);
  const tableName = `${TABLE_PREFIX}${slug}`;
  // `user` 等は slug として安全であり、接頭辞込みの完全名なら SQL 予約語でもない。
  // SQL 識別子としての最終検証は、実際に補間する完全な表名に対して行う。
  assertSafeIdentifier(tableName, "storage table");
  return tableName;
}

/**
 * project key から storage slug の候補を導出する (新規登録時の初期値)。
 * migration 043 の backfill と同じ規則:
 *   小文字化 → 非許可文字を `_` に置換 → 先頭が英字でなければ `p_` を前置 → 50 文字で切る。
 * 一意性はここでは保証しない (allocateStorageSlug が担う)。
 */
export function deriveStorageSlug(projectKey: string): string {
  let base = projectKey.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!/^[a-z]/.test(base)) base = `p_${base}`;
  base = base.slice(0, MAX_STORAGE_SLUG_LENGTH);
  if (base.length < 2) base = `${base}_`.slice(0, 2);
  return base;
}

/**
 * 既存 slug と衝突しない slug を選ぶ。`base`, `base_2`, `base_3` ... の順に試す。
 * 末尾を付けても 50 文字に収まるよう base を削る。
 */
export function pickUniqueStorageSlug(base: string, taken: ReadonlySet<string>): string {
  assertStorageSlug(base);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, MAX_STORAGE_SLUG_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`could not allocate a unique storage slug for "${base}"`);
}
