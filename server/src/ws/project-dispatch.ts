/**
 * プロジェクト WS コマンドディスパッチャ
 *
 * プロジェクト (Schedula 等) が Cernere 経由で実行できるコマンドを定義する。
 * ユーザー WS の dispatch とは別管理 — プロジェクトは userId を明示指定し、
 * ユーザーセッションの制約 (自分のデータのみ) は受けない。
 */

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";

interface ProfileGetParams {
  userId?: string;
}

interface ProfileUpdateParams {
  userId?: string;
  displayName?: string;
  avatarUrl?: string | null;
  bio?: string;
  roleTitle?: string;
  expertise?: string[];
  hobbies?: string[];
  extra?: Record<string, unknown>;
}

function requireStr(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v) {
    throw new Error(`Missing or invalid field: ${key}`);
  }
  return v;
}

export async function dispatchProjectCommand(
  projectKey: string,
  module: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  switch (`${module}.${action}`) {
    case "profile.get":
      return getUserProfile(payload as ProfileGetParams);
    case "profile.update":
      return updateUserProfile(payload as ProfileUpdateParams);
    // ─── auth (embedded SPA login for mobile; CORS-free via project WS) ───
    case "auth.login":
    case "auth.register":
    case "auth.mfa-verify": {
      const { executeCompositeAction } = await import("../http/composite-handler.js");
      return executeCompositeAction(action as "login" | "register" | "mfa-verify", payload);
    }
    default:
      throw new Error(`Unknown command: ${module}.${action} (project: ${projectKey})`);
  }
}

async function getUserProfile(p: ProfileGetParams): Promise<unknown> {
  const userId = requireStr(p as unknown as Record<string, unknown>, "userId");

  const userRows = await db.select().from(schema.users)
    .where(eq(schema.users.id, userId)).limit(1);
  const user = userRows[0];
  if (!user) throw new Error("User not found");

  const profileRows = await db.select().from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId)).limit(1);
  const profile = profileRows[0];

  return {
    id: user.id,
    login: user.login,
    displayName: user.displayName,
    email: user.email,
    avatarUrl: user.avatarUrl ?? null,
    role: user.role,
    bio: profile?.bio ?? "",
    roleTitle: profile?.roleTitle ?? "",
    expertise: profile?.expertise ?? [],
    hobbies: profile?.hobbies ?? [],
    extra: profile?.extra ?? {},
    privacy: profile?.privacy ?? {
      bio: true, roleTitle: true, expertise: true, hobbies: true,
    },
  };
}

async function updateUserProfile(p: ProfileUpdateParams): Promise<unknown> {
  const userId = requireStr(p as unknown as Record<string, unknown>, "userId");
  const now = new Date();

  // users テーブル側の更新 (displayName / avatarUrl)
  const userUpdates: Record<string, unknown> = { updatedAt: now };
  if (typeof p.displayName === "string") userUpdates.displayName = p.displayName;
  if (typeof p.avatarUrl === "string" || p.avatarUrl === null) userUpdates.avatarUrl = p.avatarUrl;
  if (Object.keys(userUpdates).length > 1) {
    await db.update(schema.users).set(userUpdates).where(eq(schema.users.id, userId));
  }

  // userProfiles 側
  const existing = await db.select({ userId: schema.userProfiles.userId })
    .from(schema.userProfiles).where(eq(schema.userProfiles.userId, userId)).limit(1);

  if (existing.length === 0) {
    await db.insert(schema.userProfiles).values({
      userId,
      roleTitle: p.roleTitle ?? "",
      bio: p.bio ?? "",
      expertise: p.expertise ?? [],
      hobbies: p.hobbies ?? [],
      extra: p.extra ?? {},
      privacy: { bio: true, roleTitle: true, expertise: true, hobbies: true },
      createdAt: now, updatedAt: now,
    });
  } else {
    const profileUpdates: Record<string, unknown> = { updatedAt: now };
    if (p.roleTitle !== undefined) profileUpdates.roleTitle = p.roleTitle;
    if (p.bio !== undefined) profileUpdates.bio = p.bio;
    if (p.expertise !== undefined) profileUpdates.expertise = p.expertise;
    if (p.hobbies !== undefined) profileUpdates.hobbies = p.hobbies;
    if (p.extra !== undefined) profileUpdates.extra = p.extra;
    if (Object.keys(profileUpdates).length > 1) {
      await db.update(schema.userProfiles).set(profileUpdates)
        .where(eq(schema.userProfiles.userId, userId));
    }
  }

  return getUserProfile({ userId });
}
