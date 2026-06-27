/**
 * Passkey (WebAuthn / FIDO2) REST ハンドラ
 *
 * 対応する認証器:
 *   - iOS / iPadOS : Face ID / Touch ID (iCloud Keychain で同期される passkey)
 *   - macOS        : Touch ID (Safari) / Chrome ProfileSync
 *   - Windows      : Windows Hello (顔/指紋/PIN)
 *   - Android      : 指紋/顔 (Google Password Manager で同期)
 *   - 物理キー     : YubiKey / Titan / Solokey 等 (USB / NFC / BLE)
 *
 * 外部 API は一切不要 — ブラウザ <-> Cernere サーバの直接やり取り。
 *
 * 4 つのエンドポイント (= 登録 / ログインの begin/finish のペア):
 *   POST /api/auth/passkey/register-begin   (要 認証, 任意の nickname を受ける)
 *   POST /api/auth/passkey/register-finish  (要 認証, ブラウザ署名を verify)
 *   POST /api/auth/passkey/login-begin      (未認証, optional email)
 *   POST /api/auth/passkey/login-finish     (未認証, ブラウザ署名を verify → JWT 発行)
 *
 * challenge は Redis に保存して TTL 5 分。 同一ユーザは concurrent な
 * register/login を 1 件しか持てない (= 後勝ち)。
 */

import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";

import { config } from "../config.js";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { redis, checkRateLimit } from "../redis.js";
import { generateTokenPair, verifyToken, verifyProjectToken, extractBearerToken, REFRESH_TOKEN_DAYS } from "../auth/jwt.js";
import { hashRefreshToken } from "../auth/token-hash.js";
import { issueAuthCode } from "../auth/auth-code.js";
import { logUserLogin, logUserLoginFailed } from "../logging/auth-logger.js";
import { devLog } from "../logging/dev-logger.js";

interface RouteResult { status: string; data: unknown }
export interface RequestCtx { ip?: string; userAgent?: string }

const RP_NAME = config.webauthnRpName;
const RP_ID = config.webauthnRpId;
const ORIGINS = config.webauthnOrigins;
const CHALLENGE_TTL_SEC = 5 * 60;

export async function handlePasskeyRoute(
  action: string,
  body: string,
  authHeader: string,
  ctx: RequestCtx = {},
  query: string = "",
): Promise<RouteResult> {
  devLog("passkey.route", { action, ip: ctx.ip });
  switch (action) {
    case "register-begin":  return registerBegin(authHeader, parseBody(body));
    case "register-finish": return registerFinish(authHeader, parseBody(body));
    case "login-begin":     return loginBegin(parseBody(body), ctx);
    case "login-finish":    return loginFinish(parseBody(body), ctx);
    /* composite (= popup-based SSO) からの passkey verify。 通常の login-finish と違い、
     * JWT を直接返さず authCode (= Redis 1-shot ticket) を発行する。 親サービスは
     * postMessage で受け取り、 自分の backend 経由で /api/auth/exchange して
     * service_token を得る。 */
    case "composite-login-finish": return compositeLoginFinish(parseBody(body), ctx);
    case "list":            return listPasskeys(authHeader);
    case "delete":          return deletePasskey(authHeader, parseBody(body));
    /* Ostiarius 等の会場ゲートウェイがオフライン検証用に、 登録済み passkey の
     * 公開鍵を bulk 取得する。 admin (= users.role==='admin') か service (project token)
     * のみ。 秘密情報は返さない (公開鍵のみ)。 CONTRACTS.md §2 参照。 */
    case "export":          return exportPasskeys(authHeader, query);
    default:
      return { status: "404 Not Found", data: { error: `Unknown passkey action: ${action}` } };
  }
}

function parseBody(body: string): Record<string, unknown> {
  if (!body) return {};
  try { return JSON.parse(body); } catch { return {}; }
}

async function requireUserId(authHeader: string): Promise<{ id: string; role: string }> {
  const token = extractBearerToken(authHeader);
  if (!token) throw new Error("Unauthorized: missing bearer token");
  const payload = verifyToken(token);
  if (!payload || typeof payload.sub !== "string") {
    throw new Error("Unauthorized: invalid token");
  }
  return { id: payload.sub, role: (payload.role as string) || "general" };
}

function challengeKey(prefix: string, id: string): string {
  return `passkey:challenge:${prefix}:${id}`;
}

/**
 * export 用の認可。 admin 限定 (CONTRACTS.md §2)。 2 経路を許す:
 *   1. user accessToken で `users.role === 'admin'` のユーザ (運用者の手動取得)
 *   2. project token (= service-to-service Bearer。 Ostiarius の CERNERE_SERVICE_TOKEN)
 * どちらも満たさなければ 401/403。
 */
async function requireExportAuth(authHeader: string): Promise<void> {
  const token = extractBearerToken(authHeader);
  if (!token) throw new Error("Unauthorized: missing bearer token");

  // (2) service: project token (project_credentials 由来) を先に試す
  try {
    verifyProjectToken(token);
    return; // 有効な project token = service 認証成立
  } catch { /* user token として再評価 */ }

  // (1) user: accessToken を検証し、 DB の role が admin かを確認
  const payload = verifyToken(token);
  if (typeof payload.sub !== "string") throw new Error("Unauthorized: invalid token");
  const rows = await db.select({ role: schema.users.role })
    .from(schema.users).where(eq(schema.users.id, payload.sub)).limit(1);
  if (rows[0]?.role !== "admin") throw new Error("Forbidden: admin required");
}

// ─── REGISTER ─────────────────────────────────────────────────────

async function registerBegin(authHeader: string, _body: Record<string, unknown>): Promise<RouteResult> {
  const { id: userId } = await requireUserId(authHeader);
  const user = (await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1))[0];
  if (!user) throw new Error("Unauthorized: user not found");

  // 既存クレデンシャル (= 同じ認証器を 2 重登録させない)
  const existing = await db.select({
    credentialId: schema.passkeys.credentialId,
    transports: schema.passkeys.transports,
  }).from(schema.passkeys).where(eq(schema.passkeys.userId, userId));

  const opts = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: user.email ?? user.login,
    userDisplayName: user.displayName,
    userID: new TextEncoder().encode(userId),
    attestationType: "none",
    excludeCredentials: existing.map((e) => ({
      id: e.credentialId,
      transports: Array.isArray(e.transports)
        ? (e.transports as AuthenticatorTransportFuture[])
        : undefined,
    })),
    authenticatorSelection: {
      // platform (= Face ID 等内蔵) と cross-platform (= 物理キー) どちらも許可
      residentKey: "preferred",
      // 出席チェックイン (Ostiarius) が assertion を userVerification:'required' で
      // 検証するため、 登録時点で UV (生体/PIN) を必須化して整合させる。 端末貸し
      // 対策が設計の核なので、 ここはセキュア方向 (preferred → required) に寄せる。
      userVerification: "required",
    },
  });

  await redis.set(challengeKey("reg", userId), opts.challenge, "EX", CHALLENGE_TTL_SEC);
  return { status: "200 OK", data: opts };
}

async function registerFinish(authHeader: string, p: Record<string, unknown>): Promise<RouteResult> {
  const { id: userId } = await requireUserId(authHeader);
  const response = p.response as RegistrationResponseJSON | undefined;
  const nickname = typeof p.nickname === "string" ? p.nickname.trim().slice(0, 64) : null;
  if (!response) throw new Error("response is required");

  const expectedChallenge = await redis.get(challengeKey("reg", userId));
  if (!expectedChallenge) throw new Error("Challenge expired or missing — please retry");

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGINS,
    expectedRPID: RP_ID,
    // 登録 options で userVerification:'required' を指示しているので、 finish でも
    // UV フラグを必須化して「UV 無しで作られた passkey」 を弾く。 こうすると Ostiarius
    // の required 検証で確実に通る credential だけが登録される。 既存 passkey の
    // ログイン (login-finish) には影響しない (新規登録のみ)。
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Passkey registration failed verification");
  }

  const info = verification.registrationInfo;
  const credential = info.credential;
  await db.insert(schema.passkeys).values({
    id: crypto.randomUUID(),
    userId,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    deviceType: info.credentialDeviceType,           // 'singleDevice' | 'multiDevice'
    backedUp: info.credentialBackedUp,
    transports: (response.response.transports ?? []) as unknown as Record<string, unknown>[],
    nickname,
    aaguid: info.aaguid,
    createdAt: new Date(),
  });
  await redis.del(challengeKey("reg", userId));
  devLog("passkey.register.ok", { userId, credentialId: credential.id });
  return {
    status: "201 Created",
    data: { ok: true, credentialId: credential.id, nickname, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp },
  };
}

// ─── LOGIN ────────────────────────────────────────────────────────

async function loginBegin(p: Record<string, unknown>, ctx: RequestCtx): Promise<RouteResult> {
  // email が来れば「そのユーザ専用」 のクレデンシャルだけを allow に詰める。
  // 来なければ "usernameless" (= 認証器が自分の登録済 credential を提示) を許す。
  const email = typeof p.email === "string" ? p.email.trim() : "";
  await checkRateLimit(`passkey-login:${email || ctx.ip || "anon"}`, 30, 900);

  let allowCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] | undefined;
  let challengeOwner = "anon:" + crypto.randomUUID();

  if (email) {
    const user = (await db.select({ id: schema.users.id })
      .from(schema.users).where(eq(schema.users.email, email)).limit(1))[0];
    if (user) {
      const rows = await db.select({
        credentialId: schema.passkeys.credentialId,
        transports: schema.passkeys.transports,
      }).from(schema.passkeys).where(eq(schema.passkeys.userId, user.id));
      allowCredentials = rows.map((r) => ({
        id: r.credentialId,
        transports: Array.isArray(r.transports)
          ? (r.transports as AuthenticatorTransportFuture[])
          : undefined,
      }));
      challengeOwner = "user:" + user.id;
    }
  }

  const opts = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials,
    userVerification: "preferred",
  });

  await redis.set(challengeKey("login", challengeOwner), opts.challenge, "EX", CHALLENGE_TTL_SEC);
  return { status: "200 OK", data: { options: opts, challengeOwner } };
}

/** WebAuthn assertion を verify して、 紐付くユーザを返す。 verify 成功時は
 *  counter を進めて last_used_at + last_login_at を更新する。 通常 login と
 *  composite login の両方から使う共通部。 */
async function verifyPasskeyAssertion(
  p: Record<string, unknown>,
  ctx: RequestCtx,
): Promise<{
  user: typeof schema.users.$inferSelect;
  challengeOwner: string;
}> {
  const response = p.response as AuthenticationResponseJSON | undefined;
  const challengeOwner = typeof p.challengeOwner === "string" ? p.challengeOwner : "";
  if (!response) throw new Error("response is required");
  if (!challengeOwner) throw new Error("challengeOwner is required");

  const expectedChallenge = await redis.get(challengeKey("login", challengeOwner));
  if (!expectedChallenge) throw new Error("Challenge expired or missing — please retry");

  // 提示された credential.id (= base64url) で passkey を DB から引く
  const cred = (await db.select().from(schema.passkeys)
    .where(eq(schema.passkeys.credentialId, response.id)).limit(1))[0];
  if (!cred) {
    logUserLoginFailed(undefined, "passkey", "credential not registered", ctx);
    throw new Error("Unauthorized: passkey not registered");
  }

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGINS,
    expectedRPID: RP_ID,
    credential: {
      id: cred.credentialId,
      publicKey: new Uint8Array(cred.publicKey),
      counter: Number(cred.counter),
      transports: Array.isArray(cred.transports)
        ? (cred.transports as AuthenticatorTransportFuture[])
        : undefined,
    },
    requireUserVerification: false,
  });
  if (!verification.verified) {
    logUserLoginFailed(undefined, "passkey", "signature failed", ctx);
    throw new Error("Unauthorized: passkey signature failed");
  }

  // counter を進める。 既存 counter より小さい / 同じなら攻撃の徴候 (clone)
  const newCounter = verification.authenticationInfo.newCounter;
  await db.update(schema.passkeys)
    .set({ counter: newCounter, lastUsedAt: new Date() })
    .where(eq(schema.passkeys.id, cred.id));

  const user = (await db.select().from(schema.users).where(eq(schema.users.id, cred.userId)).limit(1))[0];
  if (!user) throw new Error("Unauthorized: linked user not found");

  const now = new Date();
  await db.update(schema.users).set({ lastLoginAt: now, updatedAt: now })
    .where(eq(schema.users.id, user.id));

  await redis.del(challengeKey("login", challengeOwner));
  return { user, challengeOwner };
}

async function loginFinish(p: Record<string, unknown>, ctx: RequestCtx): Promise<RouteResult> {
  const { user } = await verifyPasskeyAssertion(p, ctx);
  const { accessToken, refreshToken } = generateTokenPair(user.id, user.role);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(schema.refreshSessions).values({
    id: crypto.randomUUID(), userId: user.id, refreshToken: hashRefreshToken(refreshToken), expiresAt,
  });
  logUserLogin(user.id, user.email ?? user.login, "passkey", { ip: ctx.ip });
  return {
    status: "200 OK",
    data: {
      user: {
        id: user.id,
        login: user.login,
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        avatarUrl: user.avatarUrl,
      },
      accessToken,
      refreshToken,
    },
  };
}

/** composite popup 用 passkey finish: JWT は返さず、 authCode を発行する。
 *  親サービス (Memoria Hub 等) が postMessage で受け取り、 /api/auth/exchange
 *  経由で実トークンに交換する。 */
async function compositeLoginFinish(p: Record<string, unknown>, ctx: RequestCtx): Promise<RouteResult> {
  const { user } = await verifyPasskeyAssertion(p, ctx);
  const authCode = await issueAuthCode({
    userId: user.id,
    displayName: user.displayName,
    email: user.email,
    role: user.role ?? "general",
  });
  logUserLogin(user.id, user.email ?? user.login, "passkey-composite", { ip: ctx.ip });
  return { status: "200 OK", data: { authCode } };
}

// ─── プロフィール画面用: 一覧 + 削除 ──────────────────────────

async function listPasskeys(authHeader: string): Promise<RouteResult> {
  const { id: userId } = await requireUserId(authHeader);
  const rows = await db.select({
    id: schema.passkeys.id,
    credentialId: schema.passkeys.credentialId,
    nickname: schema.passkeys.nickname,
    deviceType: schema.passkeys.deviceType,
    backedUp: schema.passkeys.backedUp,
    aaguid: schema.passkeys.aaguid,
    createdAt: schema.passkeys.createdAt,
    lastUsedAt: schema.passkeys.lastUsedAt,
  })
    .from(schema.passkeys)
    .where(eq(schema.passkeys.userId, userId))
    .orderBy(sql`${schema.passkeys.createdAt} DESC`);
  return { status: "200 OK", data: { items: rows } };
}

async function deletePasskey(authHeader: string, p: Record<string, unknown>): Promise<RouteResult> {
  const { id: userId } = await requireUserId(authHeader);
  const id = typeof p.id === "string" ? p.id : "";
  if (!id) throw new Error("id is required");
  const removed = await db.delete(schema.passkeys)
    .where(and(eq(schema.passkeys.id, id), eq(schema.passkeys.userId, userId)))
    .returning({ id: schema.passkeys.id });
  return { status: "200 OK", data: { ok: true, removed: removed.length } };
}

// ─── EXPORT (会場ゲートウェイ用 bulk 公開鍵取得) ──────────────────
//
// Ostiarius がオフラインで WebAuthn assertion を検証するため、 登録済み
// passkey の公開鍵を一括取得する。 返すのは公開鍵 (COSE bytes を base64) と
// 検証に必要な最小フィールドのみ。 秘密情報は一切含めない。 認可は admin /
// service 限定 (requireExportAuth)。 CONTRACTS.md §2。

async function exportPasskeys(authHeader: string, query: string): Promise<RouteResult> {
  await requireExportAuth(authHeader);

  // ?project=<key> は将来の絞り込み用。 passkeys テーブルに project 概念が
  // 無い (= user に紐付くのみ) ため、 現状は受け取るだけで全件を返す。
  const project = new URLSearchParams(query).get("project") ?? undefined;

  const rows = await db.select({
    userId: schema.passkeys.userId,
    credentialId: schema.passkeys.credentialId,
    publicKey: schema.passkeys.publicKey,
    counter: schema.passkeys.counter,
    transports: schema.passkeys.transports,
  }).from(schema.passkeys);

  const credentials = rows.map((r) => ({
    userId: r.userId,
    credentialId: r.credentialId,                              // base64url (登録時のまま)
    publicKey: Buffer.from(r.publicKey).toString("base64"),   // COSE bytes → base64
    counter: Number(r.counter),
    transports: Array.isArray(r.transports) ? (r.transports as string[]) : [],
  }));

  devLog("passkey.export", { count: credentials.length, project: project ?? null });
  return { status: "200 OK", data: { credentials } };
}
