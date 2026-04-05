/**
 * プロジェクト管理ビジネスロジック
 *
 * WS コマンドから呼び出される。REST は公開しない。
 */

import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as dbSchema from "../db/schema.js";
import { AppError } from "../error.js";
import { projectDefinitionSchema, type ProjectDefinition } from "./schema.js";
import { migrateProjectSchema } from "./schema-migrator.js";

/**
 * プロジェクト一覧
 */
export async function listProjects() {
  return db.select({
    key: dbSchema.managedProjects.key,
    name: dbSchema.managedProjects.name,
    description: dbSchema.managedProjects.description,
    isActive: dbSchema.managedProjects.isActive,
    createdAt: dbSchema.managedProjects.createdAt,
  }).from(dbSchema.managedProjects);
}

/**
 * プロジェクト詳細
 */
export async function getProject(key: string) {
  const rows = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, key)).limit(1);
  if (rows.length === 0) throw AppError.notFound("Project not found");

  const p = rows[0];
  return {
    key: p.key,
    name: p.name,
    description: p.description,
    clientId: p.clientId,
    schemaDefinition: p.schemaDefinition,
    isActive: p.isActive,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/**
 * プロジェクト登録 (JSON 直接 or URL)
 */
export async function registerProject(payload: unknown) {
  let definition: ProjectDefinition;

  const input = payload as Record<string, unknown>;

  if (input?.url && typeof input.url === "string") {
    const res = await fetch(input.url);
    if (!res.ok) throw AppError.badRequest(`Failed to fetch from URL: ${res.status}`);
    const json = await res.json();
    const parsed = projectDefinitionSchema.safeParse(json);
    if (!parsed.success) {
      throw AppError.badRequest(`Invalid project definition: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
    }
    definition = parsed.data;
  } else {
    const parsed = projectDefinitionSchema.safeParse(input);
    if (!parsed.success) {
      throw AppError.badRequest(`Invalid project definition: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
    }
    definition = parsed.data;
  }

  // 既存チェック
  const existing = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, definition.project.key))
    .limit(1);

  if (existing.length > 0) {
    if (!existing[0].isActive) {
      // 再有効化
      await db.update(dbSchema.managedProjects).set({
        isActive: true,
        name: definition.project.name,
        description: definition.project.description,
        schemaDefinition: definition,
        updatedAt: new Date(),
      }).where(eq(dbSchema.managedProjects.key, definition.project.key));

      const result = await migrateProjectSchema(definition.project.key, definition);
      return { message: "Project reactivated", key: definition.project.key, columnsAdded: result.columnsAdded };
    }
    throw AppError.conflict(`Project '${definition.project.key}' already exists`);
  }

  // クライアント認証情報
  const clientId = `proj_${definition.project.key}_${crypto.randomUUID().slice(0, 8)}`;
  const clientSecret = crypto.randomUUID();
  const clientSecretHash = await bcrypt.hash(clientSecret, 12);

  await db.insert(dbSchema.managedProjects).values({
    key: definition.project.key,
    name: definition.project.name,
    description: definition.project.description,
    clientId,
    clientSecretHash,
    schemaDefinition: definition,
  });

  const result = await migrateProjectSchema(definition.project.key, definition);

  return {
    message: "Project registered",
    key: definition.project.key,
    name: definition.project.name,
    clientId,
    clientSecret,
    tableCreated: result.created,
    columnsAdded: result.columnsAdded,
  };
}

/**
 * プロジェクト論理削除
 */
export async function deleteProject(key: string) {
  const rows = await db.select({ key: dbSchema.managedProjects.key })
    .from(dbSchema.managedProjects).where(eq(dbSchema.managedProjects.key, key)).limit(1);
  if (rows.length === 0) throw AppError.notFound("Project not found");

  await db.update(dbSchema.managedProjects).set({
    isActive: false,
    updatedAt: new Date(),
  }).where(eq(dbSchema.managedProjects.key, key));

  return { message: "Project deactivated", key };
}

/**
 * スキーマ更新 (カラム追加のみ)
 */
export async function updateProjectSchema(key: string, payload: unknown) {
  const rows = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, key)).limit(1);
  if (rows.length === 0) throw AppError.notFound("Project not found");

  const parsed = projectDefinitionSchema.safeParse(payload);
  if (!parsed.success) {
    throw AppError.badRequest(`Invalid definition: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
  }
  const definition = parsed.data;

  if (definition.project.key !== key) {
    throw AppError.badRequest("Project key in body does not match request key");
  }

  const result = await migrateProjectSchema(key, definition);

  // 旧カラムで新定義にないものは保持
  const oldDef = rows[0].schemaDefinition as ProjectDefinition;
  const oldColumns = oldDef?.user_data?.columns ?? {};
  const newColumns = definition.user_data?.columns ?? {};

  for (const colName of Object.keys(oldColumns)) {
    if (!(colName in newColumns)) {
      if (!definition.user_data) definition.user_data = { columns: {} };
      definition.user_data.columns[colName] = oldColumns[colName];
    }
  }

  await db.update(dbSchema.managedProjects).set({
    name: definition.project.name,
    description: definition.project.description,
    schemaDefinition: definition,
    updatedAt: new Date(),
  }).where(eq(dbSchema.managedProjects.key, key));

  return { message: "Schema updated", key, columnsAdded: result.columnsAdded };
}
