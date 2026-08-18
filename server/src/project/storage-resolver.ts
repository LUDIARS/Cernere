/**
 * project key → storage table の解決 (DB 参照側)。
 *
 * 表名の組み立て規則は storage-slug.ts。ここは managed_projects から storage_slug を
 * 引き、検証してから `project_data_<slug>` を返すだけ。project key そのものを
 * 表名に補間する経路は残さない。
 */

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as dbSchema from "../db/schema.js";
import { AppError } from "../error.js";
import {
  deriveStorageSlug,
  pickUniqueStorageSlug,
  storageTableName,
} from "./storage-slug.js";

/** managed_projects の行のうち storage 解決に要る部分。 */
export interface StorageSlugRow {
  storageSlug: string | null;
}

/**
 * 既に読み込んだ managed_projects 行から表名を得る (追加クエリなし)。
 * slug が欠けている/不正な行は設定不備なので throw する (RULE §7.1)。
 *
 * @implements SPEC-PROJECT-STORAGE-RESOLUTION
 */
export function storageTableFromRow(row: StorageSlugRow): string {
  try {
    return storageTableName(row.storageSlug);
  } catch {
    // DB の破損値を HTTP/WS エラーへ転記しない。値の欠落は明示しつつ内容は秘匿する。
    throw AppError.internal("Project storage configuration is invalid");
  }
}

/**
 * project key から表名を解決する。project が無ければ 404。
 *
 * @implements SPEC-PROJECT-STORAGE-RESOLUTION
 */
export async function resolveStorageTable(projectKey: string): Promise<string> {
  const rows = await db.select({
    storageSlug: dbSchema.managedProjects.storageSlug,
  })
    .from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, projectKey))
    .limit(1);
  if (rows.length === 0) throw AppError.notFound("Project not found");
  return storageTableFromRow(rows[0]);
}

/**
 * 新規 project 用に、既存 slug と衝突しない storage slug を発行する。
 *
 * @implements SPEC-PROJECT-STORAGE-RESOLUTION
 */
export async function allocateStorageSlug(projectKey: string): Promise<string> {
  const base = deriveStorageSlug(projectKey);
  const rows = await db.select({ storageSlug: dbSchema.managedProjects.storageSlug })
    .from(dbSchema.managedProjects);
  const taken = new Set(rows.map((r) => r.storageSlug).filter((s): s is string => !!s));
  return pickUniqueStorageSlug(base, taken);
}
