/**
 * Profile REST ハンドラ
 *
 * ユーザーの識別情報 + プロフィール拡張情報を返す。
 * Schedula 等の外部サービスから Cernere ユーザープロフィールを参照する際に使う。
 */

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { verifyToken, extractBearerToken } from "../auth/jwt.js";

interface RouteResult {
  status: string;
  data: unknown;
}

export async function handleProfileRoute(
  action: "get" | "update",
  body: string,
  authHeader: string,
): Promise<RouteResult> {
  const token = extractBearerToken(authHeader);
  if (!token) throw new Error("Unauthorized: No token provided");
  const claims = verifyToken(token);

  if (action === "get") {
    return getProfile(claims.sub);
  }
  if (action === "update") {
    const p = body ? JSON.parse(body) : {};
    return updateProfile(claims.sub, p);
  }
  return { status: "404 Not Found", data: { error: `Unknown action: ${action}` } };
}

async function getProfile(userId: string): Promise<RouteResult> {
  const userRows = await db.select().from(schema.users)
    .where(eq(schema.users.id, userId)).limit(1);
  const user = userRows[0];
  if (!user) throw new Error("Unauthorized: User not found");

  const profileRows = await db.select().from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId)).limit(1);
  const profile = profileRows[0];

  return {
    status: "200 OK",
    data: {
      // Core identity
      id: user.id,
      login: user.login,
      displayName: user.displayName,
      email: user.email,
      avatarUrl: user.avatarUrl ?? null,
      role: user.role,
      // Profile extension
      bio: profile?.bio ?? "",
      roleTitle: profile?.roleTitle ?? "",
      expertise: profile?.expertise ?? [],
      hobbies: profile?.hobbies ?? [],
      extra: profile?.extra ?? {},
      privacy: profile?.privacy ?? {
        bio: true, roleTitle: true, expertise: true, hobbies: true,
      },
    },
  };
}

async function updateProfile(userId: string, p: Record<string, unknown>): Promise<RouteResult> {
  const now = new Date();
  const existing = await db.select({ userId: schema.userProfiles.userId })
    .from(schema.userProfiles).where(eq(schema.userProfiles.userId, userId)).limit(1);

  // users テーブル側の更新 (displayName / avatarUrl)
  const userUpdates: Record<string, unknown> = { updatedAt: now };
  if (typeof p.displayName === "string") userUpdates.displayName = p.displayName;
  if (typeof p.avatarUrl === "string" || p.avatarUrl === null) userUpdates.avatarUrl = p.avatarUrl;
  if (Object.keys(userUpdates).length > 1) {
    await db.update(schema.users).set(userUpdates).where(eq(schema.users.id, userId));
  }

  // userProfiles 側の更新
  if (existing.length === 0) {
    await db.insert(schema.userProfiles).values({
      userId,
      roleTitle: (p.roleTitle as string) ?? "",
      bio: (p.bio as string) ?? "",
      expertise: (p.expertise as string[]) ?? [],
      hobbies: (p.hobbies as string[]) ?? [],
      extra: (p.extra as Record<string, unknown>) ?? {},
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

  return getProfile(userId);
}
