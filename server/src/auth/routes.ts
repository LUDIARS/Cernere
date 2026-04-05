/**
 * 認証 REST エンドポイント
 *
 * POST /api/auth/register  — パスワード登録
 * POST /api/auth/login     — パスワードログイン (MFA 対応)
 * POST /api/auth/refresh   — トークンリフレッシュ
 * POST /api/auth/logout    — ログアウト
 * GET  /api/auth/me        — 現在のユーザー情報
 * POST /api/auth/verify    — JWT 検証 (id-cache 用)
 */

import { Hono } from "hono";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { checkRateLimit } from "../redis.js";
import {
  generateTokenPair, verifyToken, extractBearerToken, REFRESH_TOKEN_DAYS,
} from "./jwt.js";

export const authRoutes = new Hono();

// ── POST /register ───────────────────────────────────────────

authRoutes.post("/register", async (c) => {
  const body = await c.req.json<{ name: string; email: string; password: string }>();

  if (!body.name || !body.email || !body.password) {
    throw AppError.badRequest("name, email, password are required");
  }
  if (body.password.length < 8) {
    throw AppError.badRequest("Password must be at least 8 characters");
  }

  await checkRateLimit(`register:${body.email}`, 5, 600);

  // 既存ユーザーチェック
  const existing = await db.select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, body.email))
    .limit(1);

  if (existing.length > 0) {
    throw AppError.badRequest("Registration failed. Please check your input and try again.");
  }

  const passwordHash = await bcrypt.hash(body.password, 12);

  // 最初のユーザーは admin
  const countResult = await db.select({ count: sql<number>`count(*)` }).from(schema.users);
  const userCount = Number(countResult[0]?.count ?? 0);
  const role = userCount === 0 ? "admin" : "general";

  const userId = crypto.randomUUID();
  const now = new Date();

  await db.insert(schema.users).values({
    id: userId,
    login: body.name,
    displayName: body.name,
    email: body.email,
    role,
    passwordHash,
    createdAt: now,
    updatedAt: now,
  });

  const { accessToken, refreshToken } = generateTokenPair(userId, role);

  // リフレッシュセッション保存
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(schema.refreshSessions).values({
    id: crypto.randomUUID(),
    userId,
    refreshToken,
    expiresAt,
  });

  return c.json({
    user: { id: userId, displayName: body.name, email: body.email, role },
    accessToken,
    refreshToken,
  }, 201);
});

// ── POST /login ──────────────────────────────────────────────

authRoutes.post("/login", async (c) => {
  const body = await c.req.json<{
    email?: string;
    password?: string;
    grant_type?: string;
    client_id?: string;
    client_secret?: string;
  }>();

  const grantType = body.grant_type ?? "password";

  if (grantType === "client_credentials") {
    return handleToolLogin(c, body.client_id, body.client_secret);
  }

  if (!body.email || !body.password) {
    throw AppError.badRequest("email and password are required");
  }

  await checkRateLimit(`login:${body.email}`, 10, 900);

  const rows = await db.select().from(schema.users)
    .where(eq(schema.users.email, body.email)).limit(1);
  const user = rows[0];

  if (!user || !user.passwordHash) {
    throw AppError.unauthorized("Invalid email or password");
  }

  const valid = await bcrypt.compare(body.password, user.passwordHash);
  if (!valid) {
    throw AppError.unauthorized("Invalid email or password");
  }

  // MFA チェック
  if (user.mfaEnabled) {
    const methods = (user.mfaMethods as string[]) ?? [];
    // MFA チャレンジを返す（Phase 5 で実装）
    return c.json({ mfaRequired: true, mfaMethods: methods });
  }

  const now = new Date();
  await db.update(schema.users)
    .set({ lastLoginAt: now, updatedAt: now })
    .where(eq(schema.users.id, user.id));

  const { accessToken, refreshToken } = generateTokenPair(user.id, user.role);

  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(schema.refreshSessions).values({
    id: crypto.randomUUID(),
    userId: user.id,
    refreshToken,
    expiresAt,
  });

  return c.json({
    user: {
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      role: user.role,
    },
    accessToken,
    refreshToken,
  });
});

// ── POST /refresh ────────────────────────────────────────────

authRoutes.post("/refresh", async (c) => {
  const body = await c.req.json<{ refreshToken: string }>();
  if (!body.refreshToken) {
    throw AppError.badRequest("refreshToken is required");
  }

  const rows = await db.select().from(schema.refreshSessions)
    .where(eq(schema.refreshSessions.refreshToken, body.refreshToken))
    .limit(1);
  const session = rows[0];

  if (!session || new Date() > session.expiresAt) {
    throw AppError.unauthorized("Invalid or expired refresh token");
  }

  // ユーザー取得
  const userRows = await db.select().from(schema.users)
    .where(eq(schema.users.id, session.userId)).limit(1);
  const user = userRows[0];

  if (!user) {
    throw AppError.unauthorized("User not found");
  }

  // トークンローテーション
  const { accessToken, refreshToken: newRefreshToken } = generateTokenPair(user.id, user.role);

  await db.update(schema.refreshSessions)
    .set({ refreshToken: newRefreshToken })
    .where(eq(schema.refreshSessions.id, session.id));

  return c.json({ accessToken, refreshToken: newRefreshToken });
});

// ── POST /logout ─────────────────────────────────────────────

authRoutes.post("/logout", async (c) => {
  const body = await c.req.json<{ refreshToken?: string }>().catch(() => ({ refreshToken: undefined }));
  if (body.refreshToken) {
    await db.delete(schema.refreshSessions)
      .where(eq(schema.refreshSessions.refreshToken, body.refreshToken));
  }
  return c.json({ message: "Logged out" });
});

// ── GET /me ──────────────────────────────────────────────────

authRoutes.get("/me", async (c) => {
  const token = extractBearerToken(c.req.header("Authorization"));
  if (!token) throw AppError.unauthorized("No token provided");

  const claims = verifyToken(token);

  const rows = await db.select().from(schema.users)
    .where(eq(schema.users.id, claims.sub)).limit(1);
  const user = rows[0];

  if (!user) throw AppError.notFound("User not found");

  return c.json({
    id: user.id,
    name: user.displayName,
    email: user.email,
    role: user.role,
    hasGoogleAuth: !!user.googleId,
    hasPassword: !!user.passwordHash,
    googleScopes: user.googleScopes ?? [],
  });
});

// ── POST /verify (id-cache 用) ───────────────────────────────

authRoutes.post("/verify", async (c) => {
  const body = await c.req.json<{ token: string }>();

  try {
    const claims = verifyToken(body.token);
    const rows = await db.select().from(schema.users)
      .where(eq(schema.users.id, claims.sub)).limit(1);
    const user = rows[0];

    if (!user) return c.json({ valid: false });

    return c.json({
      valid: true,
      user: {
        id: user.id,
        name: user.displayName,
        email: user.email,
        role: user.role,
      },
    });
  } catch {
    return c.json({ valid: false });
  }
});

// ── Tool Client Login (client_credentials) ───────────────────

async function handleToolLogin(
  c: { json: (data: unknown, status?: number) => Response },
  clientId: string | undefined,
  clientSecret: string | undefined,
) {
  if (!clientId || !clientSecret) {
    throw AppError.badRequest("client_id and client_secret are required for client_credentials");
  }

  const rows = await db.select().from(schema.toolClients)
    .where(eq(schema.toolClients.clientId, clientId)).limit(1);
  const tc = rows[0];

  if (!tc || !tc.isActive) {
    throw AppError.unauthorized("Invalid client credentials");
  }

  const valid = await bcrypt.compare(clientSecret, tc.clientSecretHash);
  if (!valid) {
    throw AppError.unauthorized("Invalid client credentials");
  }

  const { generateToolToken } = await import("./jwt.js");
  const scopes = (tc.scopes as string[]) ?? [];
  const accessToken = generateToolToken(tc.id, tc.ownerUserId, scopes);

  await db.update(schema.toolClients)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.toolClients.id, tc.id));

  return c.json({
    tokenType: "tool",
    accessToken,
    expiresIn: 3600,
    client: {
      id: tc.id,
      name: tc.name,
      clientId: tc.clientId,
      ownerUserId: tc.ownerUserId,
      scopes,
      isActive: tc.isActive,
    },
  });
}
