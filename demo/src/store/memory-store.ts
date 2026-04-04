/**
 * In-Memory Store — デモ用データストア
 *
 * User と ExtData をメモリ上で管理する。
 * 起動時にシードデータを投入する。
 */

import type { User } from "../models/user.js";
import type { ExtData } from "../models/ext-data.js";

// ── Users ─────────────────────────────────────────────

const users = new Map<string, User>();

// ── ExtData ───────────────────────────────────────────

/** key = `${userId}:${namespace}` */
const extDataMap = new Map<string, ExtData>();

function extKey(userId: string, namespace: string): string {
  return `${userId}:${namespace}`;
}

// ── User Operations ───────────────────────────────────

export function getUser(id: string): User | undefined {
  return users.get(id);
}

export function getAllUsers(): User[] {
  return [...users.values()];
}

// ── ExtData Operations ────────────────────────────────

export function getExtData(userId: string, namespace: string): ExtData | undefined {
  return extDataMap.get(extKey(userId, namespace));
}

export function getExtDataByUser(userId: string): ExtData[] {
  const result: ExtData[] = [];
  for (const ext of extDataMap.values()) {
    if (ext.userId === userId) result.push(ext);
  }
  return result;
}

export function upsertExtData(
  userId: string,
  namespace: string,
  data: Record<string, unknown>,
): ExtData {
  const key = extKey(userId, namespace);
  const now = new Date().toISOString();
  const existing = extDataMap.get(key);

  const ext: ExtData = {
    userId,
    namespace,
    data,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  extDataMap.set(key, ext);
  return ext;
}

export function patchExtData(
  userId: string,
  namespace: string,
  patch: Record<string, unknown>,
): ExtData | undefined {
  const key = extKey(userId, namespace);
  const existing = extDataMap.get(key);
  if (!existing) return undefined;

  const merged: Record<string, unknown> = { ...existing.data };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete merged[k];
    } else {
      merged[k] = v;
    }
  }

  existing.data = merged;
  existing.updatedAt = new Date().toISOString();
  return existing;
}

export function deleteExtData(userId: string, namespace: string): boolean {
  return extDataMap.delete(extKey(userId, namespace));
}

// ── Seed Data ─────────────────────────────────────────

export function seedData(): void {
  const now = new Date().toISOString();

  // Users
  const seedUsers: User[] = [
    {
      id: "u-001",
      login: "tanaka",
      displayName: "田中 太郎",
      email: "tanaka@example.com",
      avatarUrl: "https://i.pravatar.cc/150?u=tanaka",
      role: "admin",
      createdAt: "2025-01-15T09:00:00Z",
      updatedAt: now,
    },
    {
      id: "u-002",
      login: "suzuki",
      displayName: "鈴木 花子",
      email: "suzuki@example.com",
      avatarUrl: "https://i.pravatar.cc/150?u=suzuki",
      role: "member",
      createdAt: "2025-02-20T10:30:00Z",
      updatedAt: now,
    },
    {
      id: "u-003",
      login: "yamada",
      displayName: "山田 一郎",
      email: "yamada@example.com",
      avatarUrl: "https://i.pravatar.cc/150?u=yamada",
      role: "member",
      createdAt: "2025-03-10T14:00:00Z",
      updatedAt: now,
    },
  ];

  for (const u of seedUsers) {
    users.set(u.id, u);
  }

  // ExtData — profile namespace
  const profiles: Array<{ userId: string; data: Record<string, unknown> }> = [
    {
      userId: "u-001",
      data: {
        bio: "フルスタックエンジニア。Rust と TypeScript が得意。",
        skills: ["Rust", "TypeScript", "React", "PostgreSQL"],
        interests: ["OSS", "システムアーキテクチャ", "セキュリティ"],
        location: "東京",
      },
    },
    {
      userId: "u-002",
      data: {
        bio: "UIデザイナー兼フロントエンドエンジニア。",
        skills: ["Figma", "React", "CSS", "TypeScript"],
        interests: ["UXデザイン", "アクセシビリティ", "アニメーション"],
        location: "大阪",
      },
    },
    {
      userId: "u-003",
      data: {
        bio: "バックエンドエンジニア。インフラも担当。",
        skills: ["Go", "Kubernetes", "AWS", "Terraform"],
        interests: ["クラウド", "SRE", "パフォーマンス最適化"],
        location: "福岡",
      },
    },
  ];

  for (const p of profiles) {
    extDataMap.set(extKey(p.userId, "profile"), {
      userId: p.userId,
      namespace: "profile",
      data: p.data,
      createdAt: "2025-04-01T00:00:00Z",
      updatedAt: now,
    });
  }

  // ExtData — settings namespace
  const settings: Array<{ userId: string; data: Record<string, unknown> }> = [
    {
      userId: "u-001",
      data: { theme: "dark", language: "ja", notifications: true },
    },
    {
      userId: "u-002",
      data: { theme: "light", language: "ja", notifications: true },
    },
    {
      userId: "u-003",
      data: { theme: "dark", language: "en", notifications: false },
    },
  ];

  for (const s of settings) {
    extDataMap.set(extKey(s.userId, "settings"), {
      userId: s.userId,
      namespace: "settings",
      data: s.data,
      createdAt: "2025-04-01T00:00:00Z",
      updatedAt: now,
    });
  }
}
