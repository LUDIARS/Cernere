/**
 * プロフィール REST エンドポイント
 *
 * GET    /api/profile          — 自分のプロフィール取得
 * PUT    /api/profile          — プロフィール更新
 * PUT    /api/profile/privacy  — プライバシー設定更新
 * GET    /api/users/:userId/profile — 公開プロフィール取得
 *
 * GET    /api/profile/optouts  — データオプトアウト一覧
 * POST   /api/profile/optouts  — オプトアウト追加
 * DELETE /api/profile/optouts  — オプトアウト削除
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { verifyToken, extractBearerToken } from "../auth/jwt.js";

export const profileRoutes = new Hono();

// ── Auth helper ─────────────────────────────────────────────

function requireUserId(c: { req: { header: (name: string) => string | undefined } }): string {
  const token = extractBearerToken(c.req.header("Authorization"));
  if (!token) throw AppError.unauthorized("No token provided");
  const claims = verifyToken(token);
  return claims.sub;
}

// ── GET / — 自分のプロフィール ──────────────────────────────

profileRoutes.get("/", async (c) => {
  const userId = requireUserId(c);

  const rows = await db.select().from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId)).limit(1);

  if (rows.length === 0) {
    // プロフィール未作成 → デフォルトを返す
    return c.json({
      userId,
      roleTitle: "",
      bio: "",
      expertise: [],
      hobbies: [],
      extra: {},
      privacy: { bio: true, roleTitle: true, expertise: true, hobbies: true },
    });
  }

  return c.json(rows[0]);
});

// ── PUT / — プロフィール更新 ────────────────────────────────

profileRoutes.put("/", async (c) => {
  const userId = requireUserId(c);
  const body = await c.req.json<{
    roleTitle?: string;
    bio?: string;
    expertise?: string[];
    hobbies?: string[];
    extra?: Record<string, unknown>;
  }>();

  const existing = await db.select({ userId: schema.userProfiles.userId })
    .from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId)).limit(1);

  const now = new Date();

  if (existing.length === 0) {
    await db.insert(schema.userProfiles).values({
      userId,
      roleTitle: body.roleTitle ?? "",
      bio: body.bio ?? "",
      expertise: body.expertise ?? [],
      hobbies: body.hobbies ?? [],
      extra: body.extra ?? {},
      privacy: { bio: true, roleTitle: true, expertise: true, hobbies: true },
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await db.update(schema.userProfiles)
      .set({
        ...(body.roleTitle !== undefined && { roleTitle: body.roleTitle }),
        ...(body.bio !== undefined && { bio: body.bio }),
        ...(body.expertise !== undefined && { expertise: body.expertise }),
        ...(body.hobbies !== undefined && { hobbies: body.hobbies }),
        ...(body.extra !== undefined && { extra: body.extra }),
        updatedAt: now,
      })
      .where(eq(schema.userProfiles.userId, userId));
  }

  const rows = await db.select().from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId)).limit(1);
  return c.json(rows[0]);
});

// ── PUT /privacy — プライバシー設定更新 ─────────────────────

profileRoutes.put("/privacy", async (c) => {
  const userId = requireUserId(c);
  const privacy = await c.req.json<Record<string, boolean>>();

  const existing = await db.select({ userId: schema.userProfiles.userId })
    .from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId)).limit(1);

  const now = new Date();

  if (existing.length === 0) {
    await db.insert(schema.userProfiles).values({
      userId,
      privacy,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await db.update(schema.userProfiles)
      .set({ privacy, updatedAt: now })
      .where(eq(schema.userProfiles.userId, userId));
  }

  return c.json({ message: "Privacy updated" });
});

// ── GET /optouts — オプトアウト一覧 ─────────────────────────

profileRoutes.get("/optouts", async (c) => {
  const userId = requireUserId(c);

  const rows = await db.select().from(schema.userDataOptouts)
    .where(eq(schema.userDataOptouts.userId, userId));

  return c.json(rows.map((r) => ({
    serviceId: r.serviceId,
    categoryKey: r.categoryKey,
    optedOutAt: r.optedOutAt.toISOString(),
  })));
});

// ── POST /optouts — オプトアウト追加 ────────────────────────

profileRoutes.post("/optouts", async (c) => {
  const userId = requireUserId(c);
  const body = await c.req.json<{ serviceId: string; categoryKey: string }>();

  if (!body.serviceId || !body.categoryKey) {
    throw AppError.badRequest("serviceId and categoryKey are required");
  }

  const now = new Date();

  await db.insert(schema.userDataOptouts).values({
    userId,
    serviceId: body.serviceId,
    categoryKey: body.categoryKey,
    optedOutAt: now,
  }).onConflictDoNothing();

  return c.json({
    message: "Opt-out created",
    optout: {
      serviceId: body.serviceId,
      categoryKey: body.categoryKey,
      optedOutAt: now.toISOString(),
    },
  }, 201);
});

// ── DELETE /optouts — オプトアウト削除 ───────────────────────

profileRoutes.delete("/optouts", async (c) => {
  const userId = requireUserId(c);
  const body = await c.req.json<{ serviceId: string; categoryKey: string }>();

  if (!body.serviceId || !body.categoryKey) {
    throw AppError.badRequest("serviceId and categoryKey are required");
  }

  await db.delete(schema.userDataOptouts).where(and(
    eq(schema.userDataOptouts.userId, userId),
    eq(schema.userDataOptouts.serviceId, body.serviceId),
    eq(schema.userDataOptouts.categoryKey, body.categoryKey),
  ));

  return c.json({ message: "Opt-out removed" });
});

// ── GET /api/users/:userId/profile — 公開プロフィール ────────

export const publicProfileRoutes = new Hono();

publicProfileRoutes.get("/:userId/profile", async (c) => {
  const requesterId = requireUserId(c);
  const targetUserId = c.req.param("userId");

  const profileRows = await db.select().from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, targetUserId)).limit(1);
  const userRows = await db.select().from(schema.users)
    .where(eq(schema.users.id, targetUserId)).limit(1);

  const user = userRows[0];
  if (!user) throw AppError.notFound("User not found");

  const profile = profileRows[0];
  const privacy = (profile?.privacy ?? { bio: true, roleTitle: true, expertise: true, hobbies: true }) as Record<string, boolean>;

  return c.json({
    userId: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    roleTitle: privacy.roleTitle ? (profile?.roleTitle ?? "") : undefined,
    bio: privacy.bio ? (profile?.bio ?? "") : undefined,
    expertise: privacy.expertise ? (profile?.expertise ?? []) : undefined,
    hobbies: privacy.hobbies ? (profile?.hobbies ?? []) : undefined,
  });
});
