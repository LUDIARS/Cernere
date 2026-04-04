/**
 * ExtData モデル — ユーザー拡張データ
 *
 * ユーザーに紐づく拡張可能なキーバリューデータストア。
 * 各サービスが独自の namespace でデータを保存できる。
 *
 * 例:
 *   namespace: "profile"  → { bio, skills, interests }
 *   namespace: "settings" → { theme, language, notifications }
 */

export interface ExtData {
  userId: string;
  namespace: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ExtDataResponse {
  userId: string;
  namespace: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ExtDataSummary {
  namespace: string;
  keyCount: number;
  updatedAt: string;
}

export function toExtDataResponse(ext: ExtData): ExtDataResponse {
  return {
    userId: ext.userId,
    namespace: ext.namespace,
    data: ext.data,
    createdAt: ext.createdAt,
    updatedAt: ext.updatedAt,
  };
}

export function toExtDataSummary(ext: ExtData): ExtDataSummary {
  return {
    namespace: ext.namespace,
    keyCount: Object.keys(ext.data).length,
    updatedAt: ext.updatedAt,
  };
}
