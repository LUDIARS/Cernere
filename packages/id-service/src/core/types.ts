/**
 * Id Service — コア型定義
 *
 * 全サービス共通のユーザーID / セッション / 認証の型。
 * サービス固有のプロフィール情報は ProfilePlugin で拡張する。
 */

import type Redis from "ioredis";

// ─── Core User (全サービス共通) ────────────────────────────

export interface CoreUser {
  id: string;
  name: string;
  email: string;
  role: string;
  passwordHash?: string | null;

  // Google OAuth
  googleId?: string | null;
  googleAccessToken?: string | null;
  googleRefreshToken?: string | null;
  googleTokenExpiresAt?: number | null;
  googleScopes?: string[] | null;

  // Tracking
  lastLoginAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

// ─── Session ───────────────────────────────────────────────

export interface IdSession {
  id: string;
  userId: string;
  refreshToken: string;
  expiresAt: Date;
  createdAt: Date;
}

// ─── Repository Interfaces ────────────────────────────────

export interface IdUserRepo {
  findByEmail(email: string): Promise<CoreUser | undefined>;
  findById(id: string): Promise<CoreUser | undefined>;
  findByGoogleId(googleId: string): Promise<CoreUser | undefined>;
  countAll(): Promise<number>;
  create(data: Record<string, unknown>): Promise<void>;
  update(id: string, data: Record<string, unknown>): Promise<void>;
}

export interface IdUserBasic {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: Date;
}

export interface IdUserListRepo {
  findAllBasic(): Promise<IdUserBasic[]>;
  findByIds(userIds: string[]): Promise<IdUserBasic[]>;
}

export interface IdSessionRepo {
  findByRefreshToken(token: string): Promise<IdSession | undefined>;
  create(data: {
    id: string;
    userId: string;
    refreshToken: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<void>;
  updateRefreshToken(id: string, refreshToken: string): Promise<void>;
  deleteById(id: string): Promise<void>;
  deleteByRefreshToken(token: string): Promise<void>;
}

// ─── Group (ユーザー一覧でグループ情報を付与するため) ──────

export interface IdGroupMemberRepo {
  findByUserId(userId: string): Promise<Array<{ groupId: string; role: string }>>;
  findByGroupId(groupId: string): Promise<Array<{ userId: string; groupId: string; role: string }>>;
}

export interface IdGroupRepo {
  findById(id: string): Promise<{ id: string; name: string } | undefined>;
}

// ─── App Settings ──────────────────────────────────────────

export interface IdAppSettingsRepo {
  findByKey(key: string): Promise<{ key: string; value: string } | undefined>;
}

// ─── Secret Manager ────────────────────────────────────────

export interface IdSecretManager {
  get(key: string): string | undefined;
  getOrDefault(key: string, defaultValue: string): string;
}

// ─── Redis ─────────────────────────────────────────────────

export type GetRedis = () => Redis | null;

// ─── Activity Logger ───────────────────────────────────────

export type LogActivity = (
  userId: string,
  userName: string,
  action: string,
  detail: string,
) => void;

// ─── User Role ─────────────────────────────────────────────

export type UserRole = "admin" | "group_leader" | "general";
