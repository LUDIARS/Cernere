/**
 * プロジェクト管理 REST エンドポイント
 *
 * POST   /api/projects/register  — YAML でプロジェクト登録 (admin)
 * GET    /api/projects           — プロジェクト一覧
 * GET    /api/projects/:key      — プロジェクト詳細
 * DELETE /api/projects/:key      — プロジェクト論理削除 (admin)
 * PUT    /api/projects/:key/schema — スキーマ更新 (admin)
 */

import { Hono } from "hono";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { verifyToken, extractBearerToken } from "../auth/jwt.js";
import { parseProjectYaml, validateProjectKey } from "./yaml-parser.js";
import { migrateProjectSchema } from "./schema-migrator.js";
import type { ProjectYaml } from "./types.js";

export const projectRoutes = new Hono();

// ── ミドルウェア: 認証 ───────────────────────────────────────

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

  const body = await c.req.json<{ yaml?: string; url?: string }>();

  let yamlContent: string;

  if (body.url) {
    // URL からフェッチ
    const res = await fetch(body.url);
    if (!res.ok) throw AppError.badRequest(`Failed to fetch YAML from URL: ${res.status}`);
    yamlContent = await res.text();
  } else if (body.yaml) {
    yamlContent = body.yaml;
  } else {
    throw AppError.badRequest("yaml or url is required");
  }

  // パース & バリデーション
  const definition = parseProjectYaml(yamlContent);
  validateProjectKey(definition.project.key);

  // 既存チェック
  const existing = await db.select({ key: schema.managedProjects.key })
    .from(schema.managedProjects)
    .where(eq(schema.managedProjects.key, definition.project.key))
    .limit(1);

  if (existing.length > 0) {
    // 再有効化
    const record = await db.select().from(schema.managedProjects)
      .where(eq(schema.managedProjects.key, definition.project.key)).limit(1);

    if (record[0] && !record[0].isActive) {
      await db.update(schema.managedProjects).set({
        isActive: true,
        name: definition.project.name,
        description: definition.project.description ?? "",
        schemaDefinition: definition,
        updatedAt: new Date(),
      }).where(eq(schema.managedProjects.key, definition.project.key));

      // スキーマ更新 (カラム追加のみ)
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
  await db.insert(schema.managedProjects).values({
    key: definition.project.key,
    name: definition.project.name,
    description: definition.project.description ?? "",
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
    key: schema.managedProjects.key,
    name: schema.managedProjects.name,
    description: schema.managedProjects.description,
    isActive: schema.managedProjects.isActive,
    createdAt: schema.managedProjects.createdAt,
  }).from(schema.managedProjects);

  return c.json({ projects: rows });
});

// ── GET /:key ────────────────────────────────────────────────

projectRoutes.get("/:key", async (c) => {
  requireAuth(c);
  const key = c.req.param("key");

  const rows = await db.select().from(schema.managedProjects)
    .where(eq(schema.managedProjects.key, key)).limit(1);

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

  const rows = await db.select({ key: schema.managedProjects.key })
    .from(schema.managedProjects).where(eq(schema.managedProjects.key, key)).limit(1);

  if (rows.length === 0) throw AppError.notFound("Project not found");

  // 論理削除 (テーブルは DROP しない)
  await db.update(schema.managedProjects).set({
    isActive: false,
    updatedAt: new Date(),
  }).where(eq(schema.managedProjects.key, key));

  return c.json({ message: "Project deactivated", key });
});

// ── PUT /:key/schema ─────────────────────────────────────────

projectRoutes.put("/:key/schema", async (c) => {
  requireAdmin(c);
  const key = c.req.param("key");

  const rows = await db.select().from(schema.managedProjects)
    .where(eq(schema.managedProjects.key, key)).limit(1);

  if (rows.length === 0) throw AppError.notFound("Project not found");

  const body = await c.req.json<{ yaml: string }>();
  if (!body.yaml) throw AppError.badRequest("yaml is required");

  const definition = parseProjectYaml(body.yaml);

  if (definition.project.key !== key) {
    throw AppError.badRequest("Project key in YAML does not match URL parameter");
  }

  // カラム追加のみ実行
  const result = await migrateProjectSchema(key, definition);

  // スキーマ定義を更新 (削除カラムには _deleted フラグ)
  const oldDef = rows[0].schemaDefinition as ProjectYaml;
  const oldColumns = oldDef?.user_data?.columns ?? {};
  const newColumns = definition.user_data?.columns ?? {};

  // 旧カラムで新定義にないものは _deleted マーク
  for (const colName of Object.keys(oldColumns)) {
    if (!(colName in newColumns)) {
      if (!definition.user_data) definition.user_data = { columns: {} };
      definition.user_data.columns[colName] = {
        ...oldColumns[colName],
        _deleted: true,
      } as typeof oldColumns[typeof colName] & { _deleted: boolean };
    }
  }

  await db.update(schema.managedProjects).set({
    name: definition.project.name,
    description: definition.project.description ?? "",
    schemaDefinition: definition,
    updatedAt: new Date(),
  }).where(eq(schema.managedProjects.key, key));

  return c.json({
    message: "Schema updated",
    key,
    columnsAdded: result.columnsAdded,
  });
});
