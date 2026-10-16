/**
 * 共有を受けている列の保存先の解決 (設計書 §8)。managed_projects を引くだけで、判定は shared-source.ts。
 *
 *   loadSharedProjectDefinitions — 宣言の検証 (update_schema) 用。参照された project の列と data_sharing
 *   resolveSignupSources         — 判定・保存用。いま書ける列・表名 (storage_slug)・他の共有先の名前
 */

import { inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { devLog } from "../logging/dev-logger.js";
import type { ShareGrant } from "../project/data-sharing-grant.js";
import { storageTableFromRow } from "../project/storage-resolver.js";
import type { SignupColumns } from "./declaration.js";
import type { SignupFieldsDeclaration } from "./declaration-schema.js";
import type { SignupSourceColumns } from "./requirement.js";
import { fieldSourceProject, otherProjectsSharing, writableSharedColumns, type SharedProjectDefinition } from "./shared-source.js";

/** 共有元 project の、判定・保存に要るもの。 */
export interface ResolvedSignupSource extends SignupSourceColumns {
  projectKey: string;
  storageTable: string;
}

type ProjectRow = typeof schema.managedProjects.$inferSelect;

function definitionOf(row: ProjectRow): SharedProjectDefinition {
  const def = row.schemaDefinition && typeof row.schemaDefinition === "object"
    ? row.schemaDefinition as { user_data?: { columns?: unknown }; data_sharing?: unknown } : {};
  const columns = def.user_data?.columns;
  return {
    columns: columns && typeof columns === "object" ? columns as SignupColumns : {},
    dataSharing: Array.isArray(def.data_sharing) ? def.data_sharing as ShareGrant[] : [],
  };
}

/** 宣言が参照する共有元 project の key (自分を除く)。 */
export function sourceProjectsOf(declaration: SignupFieldsDeclaration | null | undefined, ownKey: string): string[] {
  const keys = (declaration?.fields ?? []).map((f) => fieldSourceProject(f, ownKey)).filter((k): k is string => k !== null);
  return [...new Set(keys)];
}

async function activeRows(keys: readonly string[]): Promise<ProjectRow[]> {
  if (keys.length === 0) return [];
  const rows = await db.select().from(schema.managedProjects).where(inArray(schema.managedProjects.key, [...keys]));
  return rows.filter((row) => row.isActive);
}

/** 宣言の検証用。存在しない・無効な project は null。 */
export async function loadSharedProjectDefinitions(keys: readonly string[]): Promise<Record<string, SharedProjectDefinition | null>> {
  const rows = await activeRows(keys);
  return Object.fromEntries(keys.map((key) => {
    const row = rows.find((r) => r.key === key);
    return [key, row ? definitionOf(row) : null];
  }));
}

async function projectNames(keys: readonly string[]): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const rows = await db.select({ key: schema.managedProjects.key, name: schema.managedProjects.name })
    .from(schema.managedProjects).where(inArray(schema.managedProjects.key, [...keys]));
  return new Map(rows.map((r) => [r.key, r.name]));
}

/**
 * 判定・保存用。grant が外れた・無効な project は載せない (その列は聞かない・書かない)。
 * 宣言済みの列のうち、いま書ける列だけを columns に載せる。
 */
export async function resolveSignupSources(
  ownKey: string,
  declaration: SignupFieldsDeclaration | null | undefined,
): Promise<Record<string, ResolvedSignupSource>> {
  const keys = sourceProjectsOf(declaration, ownKey);
  const sources: Record<string, ResolvedSignupSource> = {};
  for (const row of await activeRows(keys)) {
    const definition = definitionOf(row);
    const writable = writableSharedColumns(definition, ownKey);
    if (!writable) {
      devLog("signup_fields.sourceNotGranted", { projectKey: ownKey, source: row.key });
      continue;
    }
    const declared = (declaration?.fields ?? []).filter((f) => fieldSourceProject(f, ownKey) === row.key).map((f) => f.column);
    const columns = Object.fromEntries(declared.filter((c) => Object.prototype.hasOwnProperty.call(writable, c)).map((c) => [c, writable[c]]));
    const others = Object.fromEntries(Object.keys(columns).map((c) => [c, otherProjectsSharing(definition, c, ownKey)]));
    const names = await projectNames([...new Set(Object.values(others).flat())]);
    sources[row.key] = {
      projectKey: row.key,
      storageTable: storageTableFromRow(row),
      columns,
      sharedWith: Object.fromEntries(Object.entries(others).map(([c, list]) => [c, list.map((k) => names.get(k) ?? k)])),
    };
  }
  return sources;
}
