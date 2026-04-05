/**
 * プロジェクト管理 REST エンドポイント
 *
 * POST   /api/projects/register    — JSON でプロジェクト登録 (admin)
 * GET    /api/projects             — プロジェクト一覧
 * GET    /api/projects/:key        — プロジェクト詳細
 * DELETE /api/projects/:key        — プロジェクト論理削除 (admin)
 * PUT    /api/projects/:key/schema — スキーマ更新 (admin)
 */

import { Hono } from "hono";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as dbSchema from "../db/schema.js";
import { AppError } from "../error.js";
import { verifyToken, extractBearerToken } from "../auth/jwt.js";
import {
  projectDefinitionSchema,
  type ProjectDefinition,
} from "./schema.js";
import { migrateProjectSchema } from "./schema-migrator.js";

export const projectRoutes = new Hono();

// ── Auth helpers ─────────────────────────────────────────────

function requireAuth(c: { req: { header: (name: string) => string | undefined } }) {
  const token = extractBearerToken(c.req.header("Authorization"));
  if (!token) throw AppError.unauthorized("No token provided");
  return verifyToken(token);
}

function requireAdmin(c: { req: { header: (name: string) => string | undefined } }) {
  const claims = requireAuth(c);
  if (claims.role !== "admin") throw AppError.forbidden("Admin required");
  return claims;
}

// ── POST /register ───────────────────────────────────────────

projectRoutes.post("/register", async (c) => {
  requireAdmin(c);

  const body = await c.req.json();

  let definition: ProjectDefinition;

  // URL からフェッチ or JSON 直接
  if (body.url && typeof body.url === "string") {
    const res = await fetch(body.url);
    if (!res.ok) throw AppError.badRequest(`Failed to fetch from URL: ${res.status}`);
    const json = await res.json();
    const parsed = projectDefinitionSchema.safeParse(json);
    if (!parsed.success) {
      throw AppError.badRequest(`Invalid project definition: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
    }
    definition = parsed.data;
  } else {
    const parsed = projectDefinitionSchema.safeParse(body);
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
    const record = existing[0];
    if (!record.isActive) {
      // 再有効化
      await db.update(dbSchema.managedProjects).set({
        isActive: true,
        name: definition.project.name,
        description: definition.project.description,
        schemaDefinition: definition,
        updatedAt: new Date(),
      }).where(eq(dbSchema.managedProjects.key, definition.project.key));

      const result = await migrateProjectSchema(definition.project.key, definition);

      return c.json({
        message: "Project reactivated",
        key: definition.project.key,
        columnsAdded: result.columnsAdded,
      });
    }

    throw AppError.conflict(`Project '${definition.project.key}' already exists`);
  }

  // クライアント認証情報生成
  const clientId = `proj_${definition.project.key}_${crypto.randomUUID().slice(0, 8)}`;
  const clientSecret = crypto.randomUUID();
  const clientSecretHash = await bcrypt.hash(clientSecret, 12);

  // DB 登録
  await db.insert(dbSchema.managedProjects).values({
    key: definition.project.key,
    name: definition.project.name,
    description: definition.project.description,
    clientId,
    clientSecretHash,
    schemaDefinition: definition,
  });

  // テーブル作成
  const result = await migrateProjectSchema(definition.project.key, definition);

  return c.json({
    message: "Project registered",
    key: definition.project.key,
    name: definition.project.name,
    clientId,
    clientSecret, // 初回のみ返却
    tableCreated: result.created,
    columnsAdded: result.columnsAdded,
  }, 201);
});

// ── GET / ────────────────────────────────────────────────────

projectRoutes.get("/", async (c) => {
  requireAuth(c);

  const rows = await db.select({
    key: dbSchema.managedProjects.key,
    name: dbSchema.managedProjects.name,
    description: dbSchema.managedProjects.description,
    isActive: dbSchema.managedProjects.isActive,
    createdAt: dbSchema.managedProjects.createdAt,
  }).from(dbSchema.managedProjects);

  return c.json({ projects: rows });
});

// ── GET /:key ────────────────────────────────────────────────

projectRoutes.get("/:key", async (c) => {
  requireAuth(c);
  const key = c.req.param("key");

  const rows = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, key)).limit(1);
  if (rows.length === 0) throw AppError.notFound("Project not found");

  const project = rows[0];
  return c.json({
    key: project.key,
    name: project.name,
    description: project.description,
    clientId: project.clientId,
    schemaDefinition: project.schemaDefinition,
    isActive: project.isActive,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  });
});

// ── DELETE /:key ─────────────────────────────────────────────

projectRoutes.delete("/:key", async (c) => {
  requireAdmin(c);
  const key = c.req.param("key");

  const rows = await db.select({ key: dbSchema.managedProjects.key })
    .from(dbSchema.managedProjects).where(eq(dbSchema.managedProjects.key, key)).limit(1);
  if (rows.length === 0) throw AppError.notFound("Project not found");

  await db.update(dbSchema.managedProjects).set({
    isActive: false,
    updatedAt: new Date(),
  }).where(eq(dbSchema.managedProjects.key, key));

  return c.json({ message: "Project deactivated", key });
});

// ── PUT /:key/schema ─────────────────────────────────────────

projectRoutes.put("/:key/schema", async (c) => {
  requireAdmin(c);
  const key = c.req.param("key");

  const rows = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, key)).limit(1);
  if (rows.length === 0) throw AppError.notFound("Project not found");

  const body = await c.req.json();
  const parsed = projectDefinitionSchema.safeParse(body);
  if (!parsed.success) {
    throw AppError.badRequest(`Invalid definition: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
  }
  const definition = parsed.data;

  if (definition.project.key !== key) {
    throw AppError.badRequest("Project key in body does not match URL parameter");
  }

  // カラム追加のみ実行
  const result = await migrateProjectSchema(key, definition);

  // 旧カラムで新定義にないものは _deleted マーク
  const oldDef = rows[0].schemaDefinition as ProjectDefinition;
  const oldColumns = oldDef?.user_data?.columns ?? {};
  const newColumns = definition.user_data?.columns ?? {};

  for (const colName of Object.keys(oldColumns)) {
    if (!(colName in newColumns)) {
      if (!definition.user_data) {
        definition.user_data = { columns: {} };
      }
      definition.user_data.columns[colName] = {
        ...oldColumns[colName],
      };
      // 論理削除フラグは schemaDefinition の JSON 内に別途記録
    }
  }

  await db.update(dbSchema.managedProjects).set({
    name: definition.project.name,
    description: definition.project.description,
    schemaDefinition: definition,
    updatedAt: new Date(),
  }).where(eq(dbSchema.managedProjects.key, key));

  return c.json({
    message: "Schema updated",
    key,
    columnsAdded: result.columnsAdded,
  });
});
