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
import {
  logUserLogin,
  logUserLoginFailed,
  logUserRegister,
  logAuthEvent,
} from "../logging/auth-logger.js";
import {
  checkDevice,
  verifyChallenge,
  resendChallengeCode,
  type DeviceFingerprint,
} from "../auth/identity-verification.js";

const AUTH_CODE_TTL = 60; // seconds
const PENDING_AUTH_TTL = 10 * 60; // 10 分: 本人確認待ちの間保持

interface RouteResult {
  status: string;
  data: unknown;
}

export interface CompositeCtx {
  ip?: string;
  userAgent?: string;
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
    case "device-verify": return compositeDeviceVerify(p, ctx);
    case "device-resend": return compositeDeviceResend(p, ctx);
    default:
      return { status: "404 Not Found", data: { error: `Unknown composite action: ${action}` } };
  }
}

/** project WS から呼ばれる auth コマンド用のエントリポイント (同じロジックを再利用) */
export async function executeCompositeAction(
  action: "login" | "register" | "mfa-verify" | "device-verify" | "device-resend",
  payload: Record<string, unknown>,
  ctx: CompositeCtx = {},
): Promise<unknown> {
  switch (action) {
    case "login":         return (await compositeLogin(payload, ctx)).data;
    case "register":      return (await compositeRegister(payload, ctx)).data;
    case "mfa-verify":    return (await compositeMfaVerify(payload, ctx)).data;
    case "device-verify": return (await compositeDeviceVerify(payload, ctx)).data;
    case "device-resend": return (await compositeDeviceResend(payload, ctx)).data;
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

/** 本人確認待ちの間、ユーザー基本情報を deviceToken に紐付けて保持 */
interface PendingUserInfo {
  userId: string;
  displayName: string;
  email: string | null;
  role: string;
}

async function storePendingAuth(deviceToken: string, info: PendingUserInfo): Promise<void> {
  await redis.set(`pending_auth:${deviceToken}`, JSON.stringify(info), "EX", PENDING_AUTH_TTL);
}

async function loadPendingAuth(deviceToken: string): Promise<PendingUserInfo | null> {
  const raw = await redis.get(`pending_auth:${deviceToken}`);
  if (!raw) return null;
  return JSON.parse(raw) as PendingUserInfo;
}

async function clearPendingAuth(deviceToken: string): Promise<void> {
  await redis.del(`pending_auth:${deviceToken}`);
}

/** payload.device を DeviceFingerprint に正規化 */
function extractFingerprint(p: Record<string, unknown>): DeviceFingerprint | undefined {
  const d = p.device;
  if (!d || typeof d !== "object") return undefined;
  const obj = d as Record<string, unknown>;
  return {
    machine: (obj.machine as Record<string, unknown> | undefined) ?? undefined,
    browser: (obj.browser as Record<string, unknown> | undefined) ?? undefined,
    geo: (obj.geo as Record<string, unknown> | undefined) ?? undefined,
  };
}

/**
 * デバイスチェックを実行し、結果に応じて authCode を返すか
 * 本人確認チャレンジを返す。
 */
async function gateAuth(
  user: { id: string; displayName: string; email: string | null; role: string },
  fp: DeviceFingerprint | undefined,
  ctx: CompositeCtx,
): Promise<RouteResult> {
  const check = await checkDevice(
    { id: user.id, email: user.email },
    fp,
    ctx,
  );

  if (check.trusted) {
    const now = new Date();
    await db.update(schema.users).set({ lastLoginAt: now, updatedAt: now })
      .where(eq(schema.users.id, user.id));
    const authCode = await issueAuthCode(user.id, user.displayName, user.email, user.role);
    return { status: "200 OK", data: { authCode } };
  }

  // 本人確認が必要 — ユーザー情報を pending として保持
  if (!check.deviceToken) {
    throw new Error("Device verification could not be initialized");
  }
  await storePendingAuth(check.deviceToken, {
    userId: user.id,
    displayName: user.displayName,
    email: user.email,
    role: user.role,
  });

  return {
    status: "200 OK",
    data: {
      deviceVerificationRequired: true,
      deviceToken: check.deviceToken,
      anomalies: check.anomalies,
      emailMasked: check.emailMasked,
      codeChannel: check.codeChannel,
      deviceLabel: check.label,
    },
  };
}

async function compositeLogin(p: Record<string, unknown>, ctx: CompositeCtx): Promise<RouteResult> {
  const email = p.email as string | undefined;
  const password = p.password as string | undefined;
  if (!email || !password) {
    logUserLoginFailed(email, "composite", "missing credentials", ctx);
    throw new Error("email and password are required");
  }

  await checkRateLimit(`login:${email}`, 10, 900);

  const rows = await db.select().from(schema.users)
    .where(eq(schema.users.email, email)).limit(1);
  const user = rows[0];
  if (!user || !user.passwordHash) {
    logUserLoginFailed(email, "composite", "invalid credentials", ctx);
    throw new Error("Unauthorized: Invalid email or password");
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    logUserLoginFailed(email, "composite", "invalid credentials", ctx);
    throw new Error("Unauthorized: Invalid email or password");
  }

  if (user.mfaEnabled) {
    logAuthEvent({ event: "user.mfa.challenge", userId: user.id, email: user.email ?? undefined, provider: "composite", ip: ctx.ip, userAgent: ctx.userAgent });
    return {
      status: "200 OK",
      data: { mfaRequired: true, mfaMethods: user.mfaMethods ?? [] },
    };
  }

  logUserLogin(user.id, user.email, "composite", ctx);
  return gateAuth(
    { id: user.id, displayName: user.displayName ?? "", email: user.email, role: user.role },
    extractFingerprint(p),
    ctx,
  );
}

async function compositeRegister(p: Record<string, unknown>, ctx: CompositeCtx): Promise<RouteResult> {
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

  logUserRegister(userId, email, "composite", { ip: ctx.ip });
  // 新規登録時は当該デバイスを必ず確認 (他人による不正登録の検知も兼ねる)
  return gateAuth(
    { id: userId, displayName: name, email, role },
    extractFingerprint(p),
    ctx,
  );
}

async function compositeMfaVerify(p: Record<string, unknown>, ctx: CompositeCtx): Promise<RouteResult> {
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

  logAuthEvent({ event: "user.mfa.verified", userId: user.id, email: user.email ?? undefined, provider: "composite", ip: ctx.ip, userAgent: ctx.userAgent });
  logUserLogin(user.id, user.email, "composite_mfa", ctx);

  return gateAuth(
    { id: user.id, displayName: user.displayName ?? "", email: user.email, role: user.role },
    extractFingerprint(p),
    ctx,
  );
}

/**
 * デバイス本人確認: ユーザーが入力したコードを検証し、信頼済みデバイスに登録する。
 * 検証成功時は authCode を発行する。
 */
async function compositeDeviceVerify(p: Record<string, unknown>, ctx: CompositeCtx): Promise<RouteResult> {
  const deviceToken = p.deviceToken as string | undefined;
  const code = p.code as string | undefined;
  if (!deviceToken || !code) throw new Error("deviceToken and code are required");

  await checkRateLimit(`device_verify:${deviceToken}`, 10, 600);

  const result = await verifyChallenge(deviceToken, code);
  if (!result.ok) {
    if (result.remainingAttempts !== undefined) {
      return {
        status: "200 OK",
        data: { error: result.error, remainingAttempts: result.remainingAttempts },
      };
    }
    throw new Error(`Unauthorized: ${result.error ?? "Verification failed"}`);
  }

  const pending = await loadPendingAuth(deviceToken);
  if (!pending) {
    throw new Error("Unauthorized: Pending authentication expired");
  }
  await clearPendingAuth(deviceToken);

  const now = new Date();
  await db.update(schema.users).set({ lastLoginAt: now, updatedAt: now })
    .where(eq(schema.users.id, pending.userId));

  const authCode = await issueAuthCode(pending.userId, pending.displayName, pending.email, pending.role);
  logAuthEvent({
    event: "user.login",
    userId: pending.userId,
    email: pending.email ?? undefined,
    provider: "composite_device_verified",
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  return { status: "200 OK", data: { authCode } };
}

/**
 * 確認コードの再送 (ユーザーが受け取れなかった場合のフォールバック)。
 */
async function compositeDeviceResend(p: Record<string, unknown>, ctx: CompositeCtx): Promise<RouteResult> {
  const deviceToken = p.deviceToken as string | undefined;
  if (!deviceToken) throw new Error("deviceToken is required");

  await checkRateLimit(`device_resend:${deviceToken}`, 3, 300);

  const ok = await resendChallengeCode(deviceToken);
  if (!ok) {
    throw new Error("Unauthorized: Verification token expired");
  }
  logAuthEvent({
    event: "user.device.challenge.resent",
    deviceToken,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  return { status: "200 OK", data: { ok: true } };
}
