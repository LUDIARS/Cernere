/**
 * Composite Auth ハンドラ
 *
 * 他サービスに組み込む用の認証フロー。
 *
 * 資格情報検証後に auth_session (Redis, 10分 TTL) を作成し
 * `{ ticket, wsPath }` を返却。クライアントは WS 経由で fingerprint を
 * 送信し、本人確認フローを完結させる。詳細は `server/src/ws/composite-auth.ts`。
 */

import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { checkRateLimit, redis } from "../redis.js";
import {
  logUserLogin,
  logUserLoginFailed,
  logUserRegister,
  logAuthEvent,
} from "../logging/auth-logger.js";
import { devLog } from "../logging/dev-logger.js";
import { createAuthSession } from "../auth/auth-session.js";

interface RouteResult {
  status: string;
  data: unknown;
}

export interface CompositeCtx {
  ip?: string;
  userAgent?: string;
  /**
   * project_credentials 経由で送られてきたリクエストの場合、その projectKey.
   * 直接 REST `/api/auth/composite/...` の場合は undefined.
   * `ensureUserProjectRow` の呼び出し対象を決めるのに使う.
   */
  projectKey?: string;
}

export async function handleCompositeRoute(
  action: string,
  body: string,
  ctx: CompositeCtx = {},
): Promise<RouteResult> {
  const p = parseBody(body);
  switch (action) {
    case "login": return compositeLogin(p, ctx);
    case "register": return compositeRegister(p, ctx);
    case "mfa-verify": return compositeMfaVerify(p, ctx);
    default:
      return { status: "404 Not Found", data: { error: `Unknown composite action: ${action}` } };
  }
}

/** project WS から呼ばれる auth コマンド用のエントリポイント */
export async function executeCompositeAction(
  action: "login" | "register" | "mfa-verify",
  payload: Record<string, unknown>,
  ctx: CompositeCtx = {},
): Promise<unknown> {
  switch (action) {
    case "login":      return (await compositeLogin(payload, ctx)).data;
    case "register":   return (await compositeRegister(payload, ctx)).data;
    case "mfa-verify": return (await compositeMfaVerify(payload, ctx)).data;
  }
}

/** auth_session 作成時に projectKey を伝搬する共通ラッパ */
function sessionCtx(ctx: CompositeCtx): { ip?: string; userAgent?: string; projectKey?: string } {
  return { ip: ctx.ip, userAgent: ctx.userAgent, projectKey: ctx.projectKey };
}

function parseBody(body: string): Record<string, unknown> {
  if (!body) return {};
  try { return JSON.parse(body); } catch { return {}; }
}

/**
 * 資格情報検証に成功したユーザーを auth_session として保存し、
 * ticket + wsPath を返す。fingerprint と本人確認は WS で行う。
 */
async function openAuthSession(
  user: { id: string; displayName: string; email: string | null; role: string },
  ctx: CompositeCtx,
): Promise<RouteResult> {
  const session = await createAuthSession(
    {
      userId: user.id,
      displayName: user.displayName,
      email: user.email,
      role: user.role,
    },
    sessionCtx(ctx),
  );
  return {
    status: "200 OK",
    data: {
      deviceVerificationRequired: true,
      ticket: session.ticket,
      wsPath: `/auth/composite-ws?ticket=${session.ticket}`,
    },
  };
}

async function compositeLogin(p: Record<string, unknown>, ctx: CompositeCtx): Promise<RouteResult> {
  const email = p.email as string | undefined;
  const password = p.password as string | undefined;
  devLog("composite.login.begin", { email, ip: ctx.ip });
  if (!email || !password) {
    logUserLoginFailed(email, "composite", "missing credentials", ctx);
    throw new Error("email and password are required");
  }

  devLog("composite.login.rateLimit", { email });
  await checkRateLimit(`login:${email}`, 10, 900);

  devLog("composite.login.lookupUser", { email });
  const rows = await db.select().from(schema.users)
    .where(eq(schema.users.email, email)).limit(1);
  const user = rows[0];
  if (!user || !user.passwordHash) {
    devLog("composite.login.userNotFound", { email });
    logUserLoginFailed(email, "composite", "invalid credentials", ctx);
    throw new Error("Unauthorized: Invalid email or password");
  }

  devLog("composite.login.verifyPassword", { userId: user.id });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    devLog("composite.login.passwordInvalid", { userId: user.id });
    logUserLoginFailed(email, "composite", "invalid credentials", ctx);
    throw new Error("Unauthorized: Invalid email or password");
  }

  if (user.mfaEnabled) {
    devLog("composite.login.mfaRequired", { userId: user.id });
    logAuthEvent({ event: "user.mfa.challenge", userId: user.id, email: user.email ?? undefined, provider: "composite", ip: ctx.ip, userAgent: ctx.userAgent });
    return {
      status: "200 OK",
      data: { mfaRequired: true, mfaMethods: user.mfaMethods ?? [] },
    };
  }

  devLog("composite.login.openSession", { userId: user.id });
  logUserLogin(user.id, user.email, "composite", ctx);
  return openAuthSession(
    { id: user.id, displayName: user.displayName ?? "", email: user.email, role: user.role },
    ctx,
  );
}

async function compositeRegister(p: Record<string, unknown>, ctx: CompositeCtx): Promise<RouteResult> {
  const name = p.name as string | undefined;
  const email = p.email as string | undefined;
  const password = p.password as string | undefined;
  devLog("composite.register.begin", { email, ip: ctx.ip });

  if (!name || !email || !password) throw new Error("name, email, password are required");
  if (password.length < 8) throw new Error("Password must be at least 8 characters");

  devLog("composite.register.rateLimit", { email });
  await checkRateLimit(`register:${email}`, 5, 600);

  devLog("composite.register.checkExisting", { email });
  const existing = await db.select({ id: schema.users.id })
    .from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (existing.length > 0) throw new Error("Registration failed. Please check your input and try again.");

  devLog("composite.register.hashPassword");
  const passwordHash = await bcrypt.hash(password, 12);
  const countResult = await db.select({ count: sql<number>`count(*)` }).from(schema.users);
  const role = Number(countResult[0]?.count ?? 0) === 0 ? "admin" : "general";
  const userId = crypto.randomUUID();
  const now = new Date();

  devLog("composite.register.insertUser", { userId, role });
  await db.insert(schema.users).values({
    id: userId, login: name, displayName: name, email, role, passwordHash,
    createdAt: now, updatedAt: now,
  });

  devLog("composite.register.openSession", { userId });
  logUserRegister(userId, email, "composite", { ip: ctx.ip });
  return openAuthSession(
    { id: userId, displayName: name, email, role },
    ctx,
  );
}

async function compositeMfaVerify(p: Record<string, unknown>, ctx: CompositeCtx): Promise<RouteResult> {
  const mfaToken = p.mfaToken as string | undefined;
  const method = p.method as string | undefined;
  const code = p.code as string | undefined;

  if (!mfaToken || !method || !code) throw new Error("mfaToken, method, and code are required");

  const raw = await redis.get(`mfa:${mfaToken}`);
  if (!raw) throw new Error("Unauthorized: Invalid or expired MFA token");

  const mfaData = JSON.parse(raw) as { userId: string; expectedCode?: string };

  const userRows = await db.select().from(schema.users)
    .where(eq(schema.users.id, mfaData.userId)).limit(1);
  const user = userRows[0];
  if (!user) throw new Error("Unauthorized: User not found");

  await redis.del(`mfa:${mfaToken}`);

  logAuthEvent({ event: "user.mfa.verified", userId: user.id, email: user.email ?? undefined, provider: "composite", ip: ctx.ip, userAgent: ctx.userAgent });
  logUserLogin(user.id, user.email, "composite_mfa", ctx);

  return openAuthSession(
    { id: user.id, displayName: user.displayName ?? "", email: user.email, role: user.role },
    ctx,
  );
}
