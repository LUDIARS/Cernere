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
  module: z.string().min(1, "module is required"),
  nullable: z.boolean().optional().default(true),
  description: z.string().optional(),
  default_value: z.string().optional(),
});
export type ColumnDefinition = z.infer<typeof columnDefinitionSchema>;

// ── エンドポイント定義 ───────────────────────────────────────

export const endpointDefinitionSchema = z.object({
  /** サービスのベース URL (例: "http://localhost:3000") */
  url: z.string().url(),
  /** フロントエンドの URL (例: "http://localhost:5173") */
  frontend_url: z.string().url().optional(),
  /** Cernere と同一サーバー上で動作しているか */
  same_server: z.boolean().optional().default(false),
  /** 同一サーバーの場合のフロントエンドブリッジパス (例: "/schedula") */
  bridge_path: z.string().optional(),
});
export type EndpointDefinition = z.infer<typeof endpointDefinitionSchema>;

// ── データ共有定義 ───────────────────────────────────────────

export const dataShareDefinitionSchema = z.object({
  /** 共有先プロジェクトキー */
  project_key: z.string().min(1),
  /** 共有するモジュール (省略時は全モジュール) */
  modules: z.array(z.string()).optional(),
  /** 共有方向: "read" = 読み取りのみ, "readwrite" = 読み書き */
  access: z.enum(["read", "readwrite"]).optional().default("read"),
  /** 共有の説明 */
  description: z.string().optional(),
});
export type DataShareDefinition = z.infer<typeof dataShareDefinitionSchema>;

// ── プロジェクト定義 ─────────────────────────────────────────

const projectKeyRegex = /^[a-z][a-z0-9_]{1,62}$/;

export const projectDefinitionSchema = z.object({
  project: z.object({
    key: z.string()
      .regex(projectKeyRegex, "key must be lowercase alphanumeric + underscore, 2-63 chars, starting with a letter"),
    name: z.string().min(1, "name is required"),
    description: z.string().optional().default(""),
  }),
  /** サービスのエンドポイント */
  endpoint: endpointDefinitionSchema.optional(),
  /** データを共有できるプロジェクト */
  data_sharing: z.array(dataShareDefinitionSchema).optional(),
  /** ユーザーデータのカラム定義 (各カラムの module フィールドでモジュール帰属を管理) */
  user_data: z.object({
    columns: z.record(z.string(), columnDefinitionSchema),
  }).optional(),
});

export type ProjectDefinition = z.infer<typeof projectDefinitionSchema>;

// ── リクエストスキーマ ───────────────────────────────────────

export const registerProjectRequestSchema = projectDefinitionSchema;

export const updateSchemaRequestSchema = projectDefinitionSchema;
