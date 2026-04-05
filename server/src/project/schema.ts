/**
 * プロジェクト定義の Zod スキーマ + 型定義
 */

import { z } from "zod";

// ── カラム型 ─────────────────────────────────────────────────

export const columnTypeEnum = z.enum([
  "text", "integer", "bigint", "boolean", "timestamp", "json", "uuid",
]);
export type ColumnType = z.infer<typeof columnTypeEnum>;

export const COLUMN_TYPE_MAP: Record<ColumnType, string> = {
  text: "TEXT",
  integer: "INTEGER",
  bigint: "BIGINT",
  boolean: "BOOLEAN",
  timestamp: "TIMESTAMPTZ",
  json: "JSONB",
  uuid: "UUID",
};

// ── カラム定義 ───────────────────────────────────────────────

export const columnDefinitionSchema = z.object({
  type: columnTypeEnum,
  module: z.string().min(1, "module is required"),  // 所属モジュール
  nullable: z.boolean().optional().default(true),
  description: z.string().optional(),
  default_value: z.string().optional(),
});
export type ColumnDefinition = z.infer<typeof columnDefinitionSchema>;

// ── モジュール定義 ───────────────────────────────────────────

export const moduleDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(""),
});
export type ModuleDefinition = z.infer<typeof moduleDefinitionSchema>;

// ── プロジェクト定義 ─────────────────────────────────────────

const projectKeyRegex = /^[a-z][a-z0-9_]{1,62}$/;

export const projectDefinitionSchema = z.object({
  project: z.object({
    key: z.string()
      .regex(projectKeyRegex, "key must be lowercase alphanumeric + underscore, 2-63 chars, starting with a letter"),
    name: z.string().min(1, "name is required"),
    description: z.string().optional().default(""),
  }),
  modules: z.record(z.string(), moduleDefinitionSchema).optional(),
  user_data: z.object({
    columns: z.record(z.string(), columnDefinitionSchema),
  }).optional(),
});

export type ProjectDefinition = z.infer<typeof projectDefinitionSchema>;

// ── 登録リクエスト ───────────────────────────────────────────

export const registerProjectRequestSchema = z.union([
  projectDefinitionSchema,
  z.object({ url: z.string().url() }),
]);

// ── スキーマ更新リクエスト ────────────────────────────────────

export const updateSchemaRequestSchema = projectDefinitionSchema;
