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
  /** 論理削除フラグ: true の場合、DB カラムは残すがスキーマ上は削除扱い */
  _deleted: z.boolean().optional(),
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
  /**
   * 共有するカラム。省略時は既存定義との互換性のため modules 範囲内の全カラム、
   * 明示時は空配列を含めて指定カラムだけを許可する。
   */
  columns: z.array(z.string().min(1)).optional(),
  /** 共有方向: "read" = 読み取りのみ, "readwrite" = 読み書き */
  access: z.enum(["read", "readwrite"]).optional().default("read"),
  /** 共有の説明 */
  description: z.string().optional(),
});
export type DataShareDefinition = z.infer<typeof dataShareDefinitionSchema>;

// ── identity claim 定義 ──────────────────────────────────────

/**
 * プロジェクトへ開示できる users 側の identity 列。
 *
 * これらは project_data_<key> ではなく Cernere 中核の users 行にあるため、
 * user_data.columns の宣言では届かない。どのプロジェクトがどの claim を
 * 読めるかは `identity_claims` で宣言する。
 *
 * data_sharing と同じく **管理者所有フィールド**。プロジェクトクライアントが
 * update_schema で自己申告しても保存されない (自己付与の禁止)。
 * 未宣言なら読めない (fail-closed)。
 *
 * 新しい claim を足すときはここに列名を追加する。値は users テーブルの列名で、
 * SQL へは識別子として補間せず、この許可リストとの照合だけに使う。
 */
export const IDENTITY_CLAIMS = ["discord_id", "discord_username"] as const;
export type IdentityClaim = (typeof IDENTITY_CLAIMS)[number];

export const identityClaimSchema = z.enum(IDENTITY_CLAIMS);

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
  /** 開示を許可された users 側 identity 列 (管理者所有、未宣言なら開示しない) */
  identity_claims: z.array(identityClaimSchema).optional(),
  /** ユーザーデータのカラム定義 (各カラムの module フィールドでモジュール帰属を管理) */
  user_data: z.object({
    columns: z.record(z.string(), columnDefinitionSchema),
  }).optional(),
}).superRefine((definition, context) => {
  const schemaColumns = definition.user_data?.columns ?? {};
  const seenProjects = new Set<string>();

  for (const [shareIndex, share] of (definition.data_sharing ?? []).entries()) {
    if (seenProjects.has(share.project_key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data_sharing", shareIndex, "project_key"],
        message: `duplicate data_sharing project: ${share.project_key}`,
      });
    }
    seenProjects.add(share.project_key);

    const seenColumns = new Set<string>();
    for (const [columnIndex, columnName] of (share.columns ?? []).entries()) {
      if (seenColumns.has(columnName)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["data_sharing", shareIndex, "columns", columnIndex],
          message: `duplicate shared column: ${columnName}`,
        });
      }
      seenColumns.add(columnName);

      if (!schemaColumns[columnName] || schemaColumns[columnName]._deleted) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["data_sharing", shareIndex, "columns", columnIndex],
          message: `shared column is not active in user_data: ${columnName}`,
        });
      }
    }
  }
});

export type ProjectDefinition = z.infer<typeof projectDefinitionSchema>;

// ── リクエストスキーマ ───────────────────────────────────────

export const registerProjectRequestSchema = projectDefinitionSchema;

export const updateSchemaRequestSchema = projectDefinitionSchema;
