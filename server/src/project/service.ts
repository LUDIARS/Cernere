/**
 * プロジェクト管理ビジネスロジック
 *
 * WS コマンドから呼び出される。REST は公開しない。
 */

import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as dbSchema from "../db/schema.js";
import { AppError } from "../error.js";
import { projectDefinitionSchema, type ProjectDefinition } from "./schema.js";
import { migrateProjectSchema } from "./schema-migrator.js";

// ── Service Templates ────────────────────────────────────────

function getServiceDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "..", "server", "service"),
    path.resolve(process.cwd(), "service"),
    path.resolve("/app", "server", "service"),
  ];
  return candidates.find((d) => fs.existsSync(d)) ?? candidates[0];
}

/** 対応サービス一覧 (service/ 以下のディレクトリ名、_template 除外) */
export function listServiceTemplates(): Array<{ key: string; name: string; description: string }> {
  const dir = getServiceDir();
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter((d) => d !== "_template" && fs.statSync(path.join(dir, d)).isDirectory())
    .map((d) => {
      const schemaPath = path.join(dir, d, "schema.json");
      if (!fs.existsSync(schemaPath)) return null;
      try {
        const json = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
        return {
          key: json.project?.key ?? d,
          name: json.project?.name ?? d,
          description: json.project?.description ?? "",
        };
      } catch {
        return { key: d, name: d, description: "" };
      }
    })
    .filter(Boolean) as Array<{ key: string; name: string; description: string }>;
}

/** サービステンプレートの schema.json を取得 */
export function getServiceTemplate(key: string): ProjectDefinition {
  const dir = getServiceDir();
  const schemaPath = path.join(dir, key, "schema.json");

  if (!fs.existsSync(schemaPath)) {
    // _template をフォールバック
    const templatePath = path.join(dir, "_template", "schema.json");
    if (!fs.existsSync(templatePath)) {
      throw AppError.notFound(`Service template '${key}' not found`);
    }
    const json = JSON.parse(fs.readFileSync(templatePath, "utf-8"));
    return projectDefinitionSchema.parse(json);
  }

  const json = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  const parsed = projectDefinitionSchema.safeParse(json);
  if (!parsed.success) {
    throw AppError.internal(`Invalid template schema for '${key}': ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

// ── Project CRUD ─────────────────────────────────────────────

export async function listProjects() {
  return db.select({
    key: dbSchema.managedProjects.key,
    name: dbSchema.managedProjects.name,
    description: dbSchema.managedProjects.description,
    isActive: dbSchema.managedProjects.isActive,
    createdAt: dbSchema.managedProjects.createdAt,
  }).from(dbSchema.managedProjects);
}

export async function getProject(key: string) {
  const rows = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, key)).limit(1);
  if (rows.length === 0) throw AppError.notFound("Project not found");

  const p = rows[0];
  const def = p.schemaDefinition as ProjectDefinition;

  // カラムの module フィールドからモジュール別にグルーピング
  const columnsByModule: Record<string, Array<{ name: string; type: string; description?: string }>> = {};
  if (def?.user_data?.columns) {
    for (const [colName, col] of Object.entries(def.user_data.columns)) {
      const mod = col.module ?? "default";
      if (!columnsByModule[mod]) columnsByModule[mod] = [];
      columnsByModule[mod].push({ name: colName, type: col.type, description: col.description });
    }
  }

  return {
    key: p.key,
    name: p.name,
    description: p.description,
    clientId: p.clientId,
    schemaDefinition: p.schemaDefinition,
    columnsByModule,
    isActive: p.isActive,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export async function registerProject(payload: unknown, userId?: string) {
  let definition: ProjectDefinition;

  const parsed = projectDefinitionSchema.safeParse(payload);
  if (!parsed.success) {
    throw AppError.badRequest(`Invalid project definition: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
  }
  definition = parsed.data;

  // 既存チェック
  const existing = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, definition.project.key))
    .limit(1);

  if (existing.length > 0) {
    if (!existing[0].isActive) {
      await db.update(dbSchema.managedProjects).set({
        isActive: true,
        name: definition.project.name,
        description: definition.project.description,
        schemaDefinition: definition,
        updatedAt: new Date(),
      }).where(eq(dbSchema.managedProjects.key, definition.project.key));

      const result = await migrateProjectSchema(definition.project.key, definition);
      await saveDefinitionHistory(definition.project.key, definition, userId);
      return { message: "Project reactivated", key: definition.project.key, columnsAdded: result.columnsAdded };
    }
    throw AppError.conflict(`Project '${definition.project.key}' already exists`);
  }

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
  await saveDefinitionHistory(definition.project.key, definition, userId);

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

export async function updateProjectSchema(key: string, payload: unknown, userId?: string) {
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

  await saveDefinitionHistory(key, definition, userId);

  return { message: "Schema updated", key, columnsAdded: result.columnsAdded };
}

// ── Definition History ───────────────────────────────────────

async function saveDefinitionHistory(projectKey: string, definition: ProjectDefinition, userId?: string) {
  // 最新バージョン番号を取得
  const latest = await db.select({ version: dbSchema.projectDefinitionHistory.version })
    .from(dbSchema.projectDefinitionHistory)
    .where(eq(dbSchema.projectDefinitionHistory.projectKey, projectKey))
    .orderBy(desc(dbSchema.projectDefinitionHistory.version))
    .limit(1);

  const nextVersion = (latest[0]?.version ?? 0) + 1;

  await db.insert(dbSchema.projectDefinitionHistory).values({
    projectKey,
    definition,
    version: nextVersion,
    appliedBy: userId ?? null,
  });
}

export async function getDefinitionHistory(projectKey: string) {
  return db.select({
    id: dbSchema.projectDefinitionHistory.id,
    version: dbSchema.projectDefinitionHistory.version,
    definition: dbSchema.projectDefinitionHistory.definition,
    appliedBy: dbSchema.projectDefinitionHistory.appliedBy,
    createdAt: dbSchema.projectDefinitionHistory.createdAt,
  }).from(dbSchema.projectDefinitionHistory)
    .where(eq(dbSchema.projectDefinitionHistory.projectKey, projectKey))
    .orderBy(desc(dbSchema.projectDefinitionHistory.version));
}

// ── Module-level Opt-out ─────────────────────────────────────

export async function listModuleOptouts(userId: string, projectKey: string) {
  return db.select().from(dbSchema.userDataOptouts)
    .where(and(
      eq(dbSchema.userDataOptouts.userId, userId),
      eq(dbSchema.userDataOptouts.serviceId, projectKey),
    ));
}

export async function setModuleOptout(userId: string, projectKey: string, moduleKey: string) {
  // category_key = "module:{moduleKey}" でモジュール単位のオプトアウトを記録
  const categoryKey = `module:${moduleKey}`;
  await db.insert(dbSchema.userDataOptouts).values({
    userId,
    serviceId: projectKey,
    categoryKey,
  }).onConflictDoNothing();
  return { message: "Opted out", projectKey, moduleKey };
}

export async function removeModuleOptout(userId: string, projectKey: string, moduleKey: string) {
  const categoryKey = `module:${moduleKey}`;
  await db.delete(dbSchema.userDataOptouts).where(and(
    eq(dbSchema.userDataOptouts.userId, userId),
    eq(dbSchema.userDataOptouts.serviceId, projectKey),
    eq(dbSchema.userDataOptouts.categoryKey, categoryKey),
  ));
  return { message: "Opt-out removed", projectKey, moduleKey };
}
