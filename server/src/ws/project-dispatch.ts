/**
 * プロジェクト WS コマンドディスパッチャ
 *
 * プロジェクト (Schedula 等) が Cernere 経由で実行できるコマンドを定義する。
 * ユーザー WS の dispatch とは別管理 — プロジェクトは userId を明示指定し、
 * ユーザーセッションの制約 (自分のデータのみ) は受けない。
 */

import { eq, and } from "drizzle-orm";
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
    // ─── managed_project: project_data_{key} へのユーザーデータアクセス ───
    // projectKey は WS セッションで bind されており、payload では受け取らない
    // (他プロジェクトの書き換えを防止)。
    case "managed_project.get_user_data": {
      const svc = await import("../project/service.js");
      const userId = requireStr(payload, "userId");
      const columns = Array.isArray(payload.columns) ? payload.columns as string[] : undefined;
      return svc.getUserColumns(projectKey, userId, columns);
    }
    case "managed_project.set_user_data": {
      const svc = await import("../project/service.js");
      const userId = requireStr(payload, "userId");
      const data = payload.data as Record<string, unknown> | undefined;
      if (!data || typeof data !== "object") {
        throw new Error("Missing or invalid field: data");
      }
      return svc.setUserData(projectKey, userId, data);
    }
    case "managed_project.delete_user_data": {
      const svc = await import("../project/service.js");
      const userId = requireStr(payload, "userId");
      const columns = Array.isArray(payload.columns) ? payload.columns as string[] : [];
      return svc.deleteUserColumns(projectKey, userId, columns);
    }
    // プロジェクトスキーマ更新 (Schedula の SDK loader が起動時に呼ぶ想定)
    case "managed_project.update_schema": {
      const svc = await import("../project/service.js");
      // payload 全体が ProjectDefinition (key は WS セッション固定と整合チェック)
      if (payload.key && payload.key !== projectKey) {
        throw new Error("project key mismatch");
      }
      const def = { ...payload, project: { ...(payload.project as object ?? {}), key: projectKey } };
      // system admin 権限は不要 (project client 認証済みのため)。
      // ただし service.updateProjectSchema は appliedBy (admin userId) を要求するため
      // project client の場合は null 渡しを許容する版が必要。
      // 既存 updateProjectSchema にそのまま委譲 (appliedBy は undefined)。
      return svc.updateProjectSchema(projectKey, def, undefined);
    }
    // ─── OAuth token storage (個人データ保管禁止ルールの基盤) ───
    case "managed_project.store_oauth_token": {
      const svc = await import("../project/service.js");
      const userId = requireStr(payload, "userId");
      const provider = requireStr(payload, "provider");
      return svc.storeOAuthToken(projectKey, userId, {
        provider,
        accessToken: (payload.accessToken ?? null) as string | null,
        refreshToken: (payload.refreshToken ?? null) as string | null,
        expiresAt: (payload.expiresAt ?? null) as string | null,
        tokenType: (payload.tokenType ?? null) as string | null,
        scope: (payload.scope ?? null) as string | null,
        metadata: (payload.metadata ?? {}) as Record<string, unknown>,
      });
    }
    case "managed_project.get_oauth_token": {
      const svc = await import("../project/service.js");
      const userId = requireStr(payload, "userId");
      const provider = requireStr(payload, "provider");
      return svc.getOAuthToken(projectKey, userId, provider);
    }
    case "managed_project.list_oauth_tokens": {
      const svc = await import("../project/service.js");
      const userId = requireStr(payload, "userId");
      return svc.listOAuthTokens(projectKey, userId);
    }
    case "managed_project.delete_oauth_token": {
      const svc = await import("../project/service.js");
      const userId = requireStr(payload, "userId");
      const provider = requireStr(payload, "provider");
      return svc.deleteOAuthToken(projectKey, userId, provider);
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
    privacy: profile?.privacy ?? {
      bio: true, roleTitle: true, expertise: true, hobbies: true,
    },
  };
}

async function updateUserProfile(p: ProfileUpdateParams): Promise<unknown> {
  const userId = requireStr(p as unknown as Record<string, unknown>, "userId");
  const now = new Date();

  // オプトアウトチェック (core/personality)
  // personality (roleTitle / bio / expertise / hobbies) への書き込みはブロック
  const personalityOptout = await db.select({ userId: schema.userDataOptouts.userId })
    .from(schema.userDataOptouts)
    .where(and(
      eq(schema.userDataOptouts.userId, userId),
      eq(schema.userDataOptouts.serviceId, "core"),
      eq(schema.userDataOptouts.categoryKey, "personality"),
    )).limit(1);
  const personalityBlocked = personalityOptout.length > 0;

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
      roleTitle: personalityBlocked ? "" : (p.roleTitle ?? ""),
      bio: personalityBlocked ? "" : (p.bio ?? ""),
      expertise: personalityBlocked ? [] : (p.expertise ?? []),
      hobbies: personalityBlocked ? [] : (p.hobbies ?? []),
      privacy: { bio: true, roleTitle: true, expertise: true, hobbies: true },
      createdAt: now, updatedAt: now,
    });
  } else {
    const profileUpdates: Record<string, unknown> = { updatedAt: now };
    // personality フィールドはオプトアウト時ブロック
    if (!personalityBlocked) {
      if (p.roleTitle !== undefined) profileUpdates.roleTitle = p.roleTitle;
      if (p.bio !== undefined) profileUpdates.bio = p.bio;
      if (p.expertise !== undefined) profileUpdates.expertise = p.expertise;
      if (p.hobbies !== undefined) profileUpdates.hobbies = p.hobbies;
    }
    if (Object.keys(profileUpdates).length > 1) {
      await db.update(schema.userProfiles).set(profileUpdates)
        .where(eq(schema.userProfiles.userId, userId));
    }
  }

  return getUserProfile({ userId });
}
