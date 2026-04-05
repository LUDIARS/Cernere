/**
 * プロジェクト YAML フォーマット型定義
 */

export interface ProjectYaml {
  project: {
    key: string;          // 英数字のみ
    name: string;         // 表示名
    description?: string;
  };
  user_data?: {
    columns: Record<string, ColumnDefinition>;
  };
}

export interface ColumnDefinition {
  type: ColumnType;
  nullable?: boolean;
  description?: string;
  default_value?: string;
}

export type ColumnType = "text" | "integer" | "bigint" | "boolean" | "timestamp" | "json" | "uuid";

export const COLUMN_TYPE_MAP: Record<ColumnType, string> = {
  text: "TEXT",
  integer: "INTEGER",
  bigint: "BIGINT",
  boolean: "BOOLEAN",
  timestamp: "TIMESTAMPTZ",
  json: "JSONB",
  uuid: "UUID",
};

export interface ManagedProjectRecord {
  key: string;
  name: string;
  description: string;
  clientId: string;
  clientSecretHash: string;
  schemaDefinition: ProjectYaml;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
