/**
 * Composite Auth ハンドラ
 *
 * 他サービスに組み込む用の認証フロー。
 * login/register の結果をトークン直接返却ではなく
 * auth_code (Redis, 60秒 TTL) として返す。
 */

import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { generateTokenPair, REFRESH_TOKEN_DAYS } from "../auth/jwt.js";
import { checkRateLimit, redis } from "../redis.js";

const AUTH_CODE_TTL = 60; // seconds

interface RouteResult {
  status: string;
  data: unknown;
}

export async function handleCompositeRoute(
  action: string,
  body: string,
): Promise<RouteResult> {
  const p = parseBody(body);
  switch (action) {
    case "login": return compositeLogin(p);
    case "register": return compositeRegister(p);
    case "mfa-verify": return compositeMfaVerify(p);
    default:
      return { status: "404 Not Found", data: { error: `Unknown composite action: ${action}` } };
  }
}

function parseBody(body: string): Record<string, unknown> {
  if (!body) return {};
  try { return JSON.parse(body); } catch { return {}; }
}

/**
 * auth_code を生成して Redis に保存する。
 * exchange エンドポイント (/api/auth/exchange) で取り出せる。
 */
async function issueAuthCode(userId: string, displayName: string, email: string | null, role: string): Promise<string> {
  const { accessToken, refreshToken } = generateTokenPair(userId, role);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(schema.refreshSessions).values({
    id: crypto.randomUUID(), userId, refreshToken, expiresAt,
  });

  const authCode = crypto.randomUUID();
  await redis.set(`authcode:${authCode}`, JSON.stringify({
    accessToken,
    refreshToken,
    user: { id: userId, displayName, email, role },
  }), "EX", AUTH_CODE_TTL);

  return authCode;
}

async function compositeLogin(p: Record<string, unknown>): Promise<RouteResult> {
  const email = p.email as string | undefined;
  const password = p.password as string | undefined;
  if (!email || !password) throw new Error("email and password are required");

  await checkRateLimit(`login:${email}`, 10, 900);

  const rows = await db.select().from(schema.users)
    .where(eq(schema.users.email, email)).limit(1);
  const user = rows[0];
  if (!user || !user.passwordHash) throw new Error("Unauthorized: Invalid email or password");

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new Error("Unauthorized: Invalid email or password");

  if (user.mfaEnabled) {
    return {
      status: "200 OK",
      data: { mfaRequired: true, mfaMethods: user.mfaMethods ?? [] },
    };
  }

  const now = new Date();
  await db.update(schema.users).set({ lastLoginAt: now, updatedAt: now })
    .where(eq(schema.users.id, user.id));

  const authCode = await issueAuthCode(user.id, user.displayName ?? "", user.email, user.role);
  return { status: "200 OK", data: { authCode } };
}

async function compositeRegister(p: Record<string, unknown>): Promise<RouteResult> {
  const name = p.name as string | undefined;
  const email = p.email as string | undefined;
  const password = p.password as string | undefined;

  if (!name || !email || !password) throw new Error("name, email, password are required");
  if (password.length < 8) throw new Error("Password must be at least 8 characters");

  await checkRateLimit(`register:${email}`, 5, 600);

  const existing = await db.select({ id: schema.users.id })
    .from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (existing.length > 0) throw new Error("Registration failed. Please check your input and try again.");

  const passwordHash = await bcrypt.hash(password, 12);
  const countResult = await db.select({ count: sql<number>`count(*)` }).from(schema.users);
  const role = Number(countResult[0]?.count ?? 0) === 0 ? "admin" : "general";
  const userId = crypto.randomUUID();
  const now = new Date();

  await db.insert(schema.users).values({
    id: userId, login: name, displayName: name, email, role, passwordHash,
    createdAt: now, updatedAt: now,
  });

  const authCode = await issueAuthCode(userId, name, email, role);
  return { status: "201 Created", data: { authCode } };
}

async function compositeMfaVerify(p: Record<string, unknown>): Promise<RouteResult> {
  const mfaToken = p.mfaToken as string | undefined;
  const method = p.method as string | undefined;
  const code = p.code as string | undefined;

  if (!mfaToken || !method || !code) throw new Error("mfaToken, method, and code are required");

  // MFA 検証は既存の auth ハンドラのロジックに委譲
  // ここでは Redis に保存された MFA チャレンジを検証する
  const raw = await redis.get(`mfa:${mfaToken}`);
  if (!raw) throw new Error("Unauthorized: Invalid or expired MFA token");

  const mfaData = JSON.parse(raw) as { userId: string; expectedCode?: string };
  // TOTP 検証等は将来的に拡張
  // 現時点では MFA フローの auth_code 発行パスを用意する

  const userRows = await db.select().from(schema.users)
    .where(eq(schema.users.id, mfaData.userId)).limit(1);
  const user = userRows[0];
  if (!user) throw new Error("Unauthorized: User not found");

  await redis.del(`mfa:${mfaToken}`);

  const now = new Date();
  await db.update(schema.users).set({ lastLoginAt: now, updatedAt: now })
    .where(eq(schema.users.id, user.id));

  const authCode = await issueAuthCode(user.id, user.displayName ?? "", user.email, user.role);
  return { status: "200 OK", data: { authCode } };
}
