/**
 * ゲスト WS セッション用 auth コマンド処理
 */

import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { checkRateLimit } from "../redis.js";
import { generateTokenPair, generateMfaToken, REFRESH_TOKEN_DAYS } from "../auth/jwt.js";

export interface GuestAuthResult {
  userId?: string;
  accessToken?: string;
  refreshToken?: string;
  user?: unknown;
  mfaRequired?: boolean;
  mfaMethods?: string[];
  mfaToken?: string;
}

export async function handleGuestAuthCommand(
  action: string,
  payload: unknown,
): Promise<GuestAuthResult> {
  const p = payload as Record<string, unknown> | undefined;
  if (!p) throw AppError.badRequest("Payload required");

  switch (action) {
    case "register": return guestRegister(p);
    case "login": return guestLogin(p);
    default:
      throw AppError.badRequest(`Guest auth action '${action}' not supported. Use 'register' or 'login'.`);
  }
}

async function guestRegister(p: Record<string, unknown>): Promise<GuestAuthResult> {
  const name = p.name as string | undefined;
  const email = p.email as string | undefined;
  const password = p.password as string | undefined;

  if (!name || !email || !password) throw AppError.badRequest("name, email, password are required");
  if (password.length < 8) throw AppError.badRequest("Password must be at least 8 characters");

  await checkRateLimit(`ws_register:${email}`, 5, 600);

  const existing = await db.select({ id: schema.users.id })
    .from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (existing.length > 0) {
    throw AppError.badRequest("Registration failed. Please check your input and try again.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const countResult = await db.select({ count: sql<number>`count(*)` }).from(schema.users);
  const role = Number(countResult[0]?.count ?? 0) === 0 ? "admin" : "general";
  const userId = crypto.randomUUID();
  const now = new Date();

  await db.insert(schema.users).values({
    id: userId, login: name, displayName: name, email, role, passwordHash,
    createdAt: now, updatedAt: now,
  });

  const { accessToken, refreshToken } = generateTokenPair(userId, role);
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(schema.refreshSessions).values({
    id: crypto.randomUUID(), userId, refreshToken, expiresAt,
  });

  return {
    userId,
    accessToken,
    refreshToken,
    user: { id: userId, displayName: name, email, role },
  };
}

async function guestLogin(p: Record<string, unknown>): Promise<GuestAuthResult> {
  const email = p.email as string | undefined;
  const password = p.password as string | undefined;

  if (!email || !password) throw AppError.badRequest("email and password are required");

  await checkRateLimit(`ws_login:${email}`, 10, 900);

  const rows = await db.select().from(schema.users)
    .where(eq(schema.users.email, email)).limit(1);
  const user = rows[0];

  if (!user || !user.passwordHash) throw AppError.unauthorized("Invalid credentials");

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw AppError.unauthorized("Invalid credentials");

  // MFA
  if (user.mfaEnabled) {
    const methods = (user.mfaMethods as string[]) ?? [];
    const mfaToken = generateMfaToken(user.id, user.role);
    return { mfaRequired: true, mfaMethods: methods, mfaToken };
  }

  const now = new Date();
  await db.update(schema.users).set({ lastLoginAt: now, updatedAt: now })
    .where(eq(schema.users.id, user.id));

  const { accessToken, refreshToken } = generateTokenPair(user.id, user.role);
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(schema.refreshSessions).values({
    id: crypto.randomUUID(), userId: user.id, refreshToken, expiresAt,
  });

  return {
    userId: user.id,
    accessToken,
    refreshToken,
    user: { id: user.id, displayName: user.displayName, email: user.email, role: user.role },
  };
}
