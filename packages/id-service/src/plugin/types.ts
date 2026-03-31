/**
 * Id Service — プラグイン型定義
 *
 * 各サービスは ProfilePlugin を登録し、コア User に
 * サービス固有のフィールドを追加できる。
 */

import type { CoreUser } from "../core/types.js";

// ─── Profile Field Definition ──────────────────────────────

export type ProfileFieldType = "string" | "number" | "boolean" | "json";

export interface ProfileFieldDef {
  type: ProfileFieldType;
  required?: boolean;
  default?: unknown;
  description?: string;
}

// ─── Profile Plugin ────────────────────────────────────────

export interface ProfilePlugin {
  /** サービスの一意識別子 (例: "schedula", "hr-system") */
  serviceId: string;

  /** サービスの表示名 */
  serviceName: string;

  /** サービス固有のプロフィールフィールド定義 */
  profileFields: Record<string, ProfileFieldDef>;

  /**
   * ユーザーリスト用のフィールド一覧。
   * profileFields のうち、一覧で返すフィールド名。
   * 省略時は全フィールドを返す。
   */
  listFields?: string[];

  /**
   * /me レスポンスに追加するフィールドを整形する。
   * profileData (DB から取得した JSON) を受け取り、
   * レスポンスにマージする object を返す。
   */
  formatForMe?: (profileData: Record<string, unknown>) => Record<string, unknown>;

  /**
   * /me レスポンスで返すサービス固有フィールド名。
   * formatForMe がない場合はこれらのキーをそのまま返す。
   */
  meFields?: string[];

  // ─── Lifecycle Hooks ──────────────────────────────────

  /** ユーザー作成後に呼ばれる */
  onUserCreated?: (user: CoreUser, profileData: Record<string, unknown>) => Promise<void>;

  /** ユーザー更新後に呼ばれる */
  onUserUpdated?: (user: CoreUser, profileData: Record<string, unknown>) => Promise<void>;

  /** ユーザー削除前に呼ばれる */
  onUserDeleted?: (userId: string) => Promise<void>;
}

// ─── Profile Data in DB ────────────────────────────────────

export interface UserServiceProfile {
  userId: string;
  serviceId: string;
  profileData: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Profile Repository ────────────────────────────────────

export interface ProfileRepo {
  findByUserAndService(userId: string, serviceId: string): Promise<UserServiceProfile | undefined>;
  findByUser(userId: string): Promise<UserServiceProfile[]>;
  upsert(userId: string, serviceId: string, profileData: Record<string, unknown>): Promise<void>;
  deleteByUser(userId: string, serviceId: string): Promise<void>;
}
