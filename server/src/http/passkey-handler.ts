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
import { z } from "zod";

import { config } from "../config.js";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { redis, checkRateLimit } from "../redis.js";
import { generateTokenPair, verifyToken, extractBearerToken, REFRESH_TOKEN_DAYS } from "../auth/jwt.js";
import { hashRefreshToken } from "../auth/token-hash.js";
import { issueAuthCode } from "../auth/auth-code.js";
import { logUserLogin, logUserLoginFailed, logUserRegister } from "../logging/auth-logger.js";
import { devLog } from "../logging/dev-logger.js";
import { requireExportAuth } from "./export-auth.js";
import { actionProofStore, httpActionBinding } from "../auth/action-proof.js";
import { AppError } from "../error.js";

interface RouteResult { status: string; data: unknown }
export interface RequestCtx { ip?: string; userAgent?: string }

const RP_NAME = config.webauthnRpName;
const RP_ID = config.webauthnRpId;
const ORIGINS = config.webauthnOrigins;
const CHALLENGE_TTL_SEC = 5 * 60;

const signupBeginSchema = z.object({
  name: z.string().trim().min(1).max(80),
  // メールアドレスは任意。 Windows Hello 等の passkey だけで登録できる
  // (email 無しアカウントの他デバイス追加は device-link 経由)。
  email: z.string().trim().toLowerCase().email().max(254).optional(),
}).strict();

const signupFinishSchema = z.object({
  signupId: z.string().uuid(),
  response: z.unknown(),
}).strict();

interface PendingPasskeySignup {
  challenge: string;
  userId: string;
  name: string;
  email: string | null;
}

export async function handlePasskeyRoute(
  action: string,
  body: string,
  authHeader: string,
  ctx: RequestCtx = {},
  query: string = "",
  actionProof: string = "",
): Promise<RouteResult> {
  devLog("passkey.route", { action, ip: ctx.ip });
  switch (action) {
    case "signup-begin":    return signupBegin(parseBody(body), ctx);
    case "signup-finish":   return signupFinish(parseBody(body), ctx);
    case "register-begin":  return registerBegin(authHeader, actionProof);
    case "register-finish": return registerFinish(authHeader, parseBody(body));
    case "login-begin":     return loginBegin(parseBody(body), ctx);
    case "login-finish":    return loginFinish(parseBody(body), ctx);
    /* composite (= popup-based SSO) からの passkey verify。 通常の login-finish と違い、
     * JWT を直接返さず authCode (= Redis 1-shot ticket) を発行する。 親サービスは
     * postMessage で受け取り、 自分の backend 経由で /api/auth/exchange して
     * service_token を得る。 */
    case "composite-login-finish": return compositeLoginFinish(parseBody(body), ctx);
    /* 他デバイス登録リンク: ログイン済み端末で one-time URL を発行し、 新しい端末が
     * その URL から自分の passkey (Windows Hello / スマホ生体認証) を同じアカウントへ
     * 追加する。 email 無しアカウントでも新端末を追加できる唯一の経路。 */
    case "device-link":            return deviceLinkCreate(authHeader, actionProof);
    case "device-register-begin":  return deviceRegisterBegin(parseBody(body), ctx);
    case "device-register-finish": return deviceRegisterFinish(parseBody(body), ctx);
    case "list":            return listPasskeys(authHeader);
    case "delete":          return deletePasskey(authHeader, parseBody(body), actionProof);
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

async function requireUserId(authHeader: string): Promise<{ id: string; role: string; token: string }> {
  const token = extractBearerToken(authHeader);
  if (!token) throw new Error("Unauthorized: missing bearer token");
  const payload = verifyToken(token);
  if (!payload || typeof payload.sub !== "string") {
    throw new Error("Unauthorized: invalid token");
  }
  return { id: payload.sub, role: (payload.role as string) || "general", token };
}

function challengeKey(prefix: string, id: string): string {
  return `passkey:challenge:${prefix}:${id}`;
}

function signupKey(signupId: string): string {
  return `passkey:signup:${signupId}`;
}

// device-link token は URL に載るため、 Redis には SHA-256 digest だけを保存する
// (spec/plan/passkey-default-authentication.md §7.3 registration_grants の簡略形)。
const DEVICE_LINK_TTL_SEC = 15 * 60;

function deviceLinkKey(tokenDigest: string): string {
  return `passkey:device-link:${tokenDigest}`;
}

function deviceRegisterKey(ceremonyId: string): string {
  return `passkey:device-register:${ceremonyId}`;
}

function digestDeviceLinkToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

// export 用の認可 (admin / service token) は他の export ルートとも共有するため
// ./export-auth.ts に切り出し済み (requireExportAuth を import して使う)。

// ─── REGISTER ─────────────────────────────────────────────────────

/**
 * パスワードを作らず、最初の passkey をそのアカウントの認証資格情報として登録する。
 * ユーザー行は WebAuthn 検証が成功するまで作成しないため、途中離脱したアカウントを残さない。
 */
async function signupBegin(p: Record<string, unknown>, ctx: RequestCtx): Promise<RouteResult> {
  const parsed = signupBeginSchema.safeParse(p);
  if (!parsed.success) throw new Error("A valid name (and optional email) is required");
  const { name, email } = parsed.data;
  await checkRateLimit(`passkey-signup:${ctx.ip ?? "anon"}`, 5, 600);

  if (email) {
    const existing = await db.select({ id: schema.users.id })
      .from(schema.users).where(eq(schema.users.email, email)).limit(1);
    if (existing.length > 0) {
      throw new Error("Registration failed. Please check your input and try again.");
    }
  }

  const userId = crypto.randomUUID();
  const signupId = crypto.randomUUID();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: email ?? name,
    userDisplayName: name,
    userID: new TextEncoder().encode(userId),
    attestationType: "none",
    excludeCredentials: [],
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
  const pending: PendingPasskeySignup = {
    challenge: options.challenge,
    userId,
    name,
    email: email ?? null,
  };
  await redis.set(signupKey(signupId), JSON.stringify(pending), "EX", CHALLENGE_TTL_SEC);
  return { status: "200 OK", data: { signupId, options } };
}

async function signupFinish(p: Record<string, unknown>, ctx: RequestCtx): Promise<RouteResult> {
  const parsed = signupFinishSchema.safeParse(p);
  if (!parsed.success) throw new Error("signupId and response are required");
  const response = parsed.data.response as RegistrationResponseJSON;

  // GETDEL により、成功・失敗を問わず ceremony は一度だけ検証できる。
  const rawPending = await redis.getdel(signupKey(parsed.data.signupId));
  if (!rawPending) throw new Error("Challenge expired or missing - please retry");
  const pending = JSON.parse(rawPending) as PendingPasskeySignup;

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: pending.challenge,
    expectedOrigin: ORIGINS,
    expectedRPID: RP_ID,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Passkey registration failed verification");
  }

  const info = verification.registrationInfo;
  const credential = info.credential;
  const now = new Date();
  const countResult = await db.select({ count: sql<number>`count(*)` }).from(schema.users);
  const role = Number(countResult[0]?.count ?? 0) === 0 ? "admin" : "general";
  const { accessToken, refreshToken } = generateTokenPair(pending.userId, role);
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);

  await db.transaction(async (tx) => {
    if (pending.email) {
      const existing = await tx.select({ id: schema.users.id })
        .from(schema.users).where(eq(schema.users.email, pending.email)).limit(1);
      if (existing.length > 0) {
        throw new Error("Registration failed. Please check your input and try again.");
      }
    }
    await tx.insert(schema.users).values({
      id: pending.userId,
      login: pending.name,
      displayName: pending.name,
      email: pending.email,
      role,
      passwordHash: null,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(schema.passkeys).values({
      id: crypto.randomUUID(),
      userId: pending.userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      transports: (response.response.transports ?? []) as unknown as Record<string, unknown>[],
      nickname: null,
      aaguid: info.aaguid,
      createdAt: now,
    });
    await tx.insert(schema.refreshSessions).values({
      id: crypto.randomUUID(),
      userId: pending.userId,
      refreshToken: hashRefreshToken(refreshToken),
      expiresAt,
    });
  });

  logUserRegister(pending.userId, pending.email ?? `(passkey-only) ${pending.name}`, "passkey", { ip: ctx.ip });
  return {
    status: "201 Created",
    data: {
      user: {
        id: pending.userId,
        displayName: pending.name,
        email: pending.email,
        role,
      },
      accessToken,
      refreshToken,
    },
  };
}

async function registerBegin(authHeader: string, actionProof: string): Promise<RouteResult> {
  const { id: userId, token } = await requireUserId(authHeader);
  const user = (await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1))[0];
  if (!user) throw new Error("Unauthorized: user not found");

  // 既存クレデンシャル (= 同じ認証器を 2 重登録させない)
  const existing = await db.select({
    credentialId: schema.passkeys.credentialId,
    transports: schema.passkeys.transports,
  }).from(schema.passkeys).where(eq(schema.passkeys.userId, userId));

  // 最初の passkey は step-up 自体に使える資格情報がまだ無いためブートストラップとして許可する。
  // 2 本目以降は、既存 passkey による fresh authentication を必須にする。
  if (existing.length > 0) {
    await actionProofStore.consume(actionProof, {
      userId,
      binding: httpActionBinding(token),
      action: "passkey.register",
      resource: userId,
    });
  }

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
    // Windows Hello では生体認証または端末 PIN、対応端末では生体認証を必須にする。
    userVerification: "required",
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
    requireUserVerification: true,
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

// ─── 他デバイス登録 (one-time device link) ────────────────────────
//
// フロー:
//   1. ログイン済み端末: POST device-link (要 step-up proof) → one-time URL
//   2. 新しい端末: URL を開き POST device-register-begin { token }
//      → grant を GETDEL (単回) して registration options + ceremonyId
//   3. 新しい端末: POST device-register-finish { ceremonyId, response }
//      → verify 成功で passkey 追加 + その端末をログイン状態にする
//
// token は 32 byte 乱数・TTL 15 分・単回。 begin 時点で消費するため、 ceremony を
// 中断した場合はリンクの再発行が必要 (fail-closed)。

async function deviceLinkCreate(
  authHeader: string,
  actionProof: string,
): Promise<RouteResult> {
  const { id: userId, token: bearer } = await requireUserId(authHeader);
  const user = (await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1))[0];
  if (!user) throw new Error("Unauthorized: user not found");
  await checkRateLimit(`passkey-device-link:${userId}`, 5, 600);

  // passkey を既に持つユーザには fresh step-up を要求する (register-begin と同じ方針)。
  // パスワード/OAuth のみのユーザは step-up に使える passkey が無いため bootstrap 扱い。
  const existing = await db.select({ id: schema.passkeys.id })
    .from(schema.passkeys).where(eq(schema.passkeys.userId, userId));
  if (existing.length > 0) {
    await actionProofStore.consume(actionProof, {
      userId,
      binding: httpActionBinding(bearer),
      action: "passkey.device_link",
      resource: userId,
    });
  }

  const linkToken = crypto.randomBytes(32).toString("base64url");
  await redis.set(
    deviceLinkKey(digestDeviceLinkToken(linkToken)),
    JSON.stringify({ userId }),
    "EX",
    DEVICE_LINK_TTL_SEC,
  );

  const url = new URL("/device-register", config.frontendUrl);
  url.searchParams.set("token", linkToken);
  devLog("passkey.deviceLink.issued", { userId });
  return { status: "200 OK", data: { url: url.toString(), expiresIn: DEVICE_LINK_TTL_SEC } };
}

async function deviceRegisterBegin(p: Record<string, unknown>, ctx: RequestCtx): Promise<RouteResult> {
  const linkToken = typeof p.token === "string" ? p.token : "";
  if (!linkToken || linkToken.length > 512) throw new Error("token is required");
  await checkRateLimit(`passkey-device-register:${ctx.ip ?? "anon"}`, 10, 600);

  // GETDEL で grant を単回消費 (並行 begin は 1 件だけ成功する)。
  const raw = await redis.getdel(deviceLinkKey(digestDeviceLinkToken(linkToken)));
  if (!raw) throw new Error("Registration link is invalid, expired, or already used");
  const { userId } = JSON.parse(raw) as { userId: string };

  const user = (await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1))[0];
  if (!user) throw new Error("Registration link is invalid, expired, or already used");

  const existing = await db.select({
    credentialId: schema.passkeys.credentialId,
    transports: schema.passkeys.transports,
  }).from(schema.passkeys).where(eq(schema.passkeys.userId, userId));

  const options = await generateRegistrationOptions({
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
      // 新端末自身の認証器 (Windows Hello / スマホ生体) を discoverable で登録する。
      residentKey: "required",
      userVerification: "required",
    },
  });

  const ceremonyId = crypto.randomUUID();
  await redis.set(
    deviceRegisterKey(ceremonyId),
    JSON.stringify({ challenge: options.challenge, userId }),
    "EX",
    CHALLENGE_TTL_SEC,
  );
  return {
    status: "200 OK",
    data: { ceremonyId, options, account: { displayName: user.displayName } },
  };
}

async function deviceRegisterFinish(p: Record<string, unknown>, ctx: RequestCtx): Promise<RouteResult> {
  const ceremonyId = typeof p.ceremonyId === "string" ? p.ceremonyId : "";
  const response = p.response as RegistrationResponseJSON | undefined;
  const nickname = typeof p.nickname === "string" ? p.nickname.trim().slice(0, 64) : null;
  if (!ceremonyId || !response) throw new Error("ceremonyId and response are required");

  const raw = await redis.getdel(deviceRegisterKey(ceremonyId));
  if (!raw) throw new Error("Challenge expired or missing - please retry from a new link");
  const pending = JSON.parse(raw) as { challenge: string; userId: string };

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: pending.challenge,
    expectedOrigin: ORIGINS,
    expectedRPID: RP_ID,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Passkey registration failed verification");
  }

  const user = (await db.select().from(schema.users)
    .where(eq(schema.users.id, pending.userId)).limit(1))[0];
  if (!user) throw new Error("Unauthorized: linked user not found");

  const info = verification.registrationInfo;
  const credential = info.credential;
  const now = new Date();
  const { accessToken, refreshToken } = generateTokenPair(user.id, user.role);
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);

  await db.transaction(async (tx) => {
    await tx.insert(schema.passkeys).values({
      id: crypto.randomUUID(),
      userId: user.id,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      transports: (response.response.transports ?? []) as unknown as Record<string, unknown>[],
      nickname,
      aaguid: info.aaguid,
      createdAt: now,
    });
    await tx.insert(schema.refreshSessions).values({
      id: crypto.randomUUID(),
      userId: user.id,
      refreshToken: hashRefreshToken(refreshToken),
      expiresAt,
    });
  });

  logUserLogin(user.id, user.email ?? user.login, "passkey-device-link", { ip: ctx.ip });
  return {
    status: "201 Created",
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

async function deletePasskey(
  authHeader: string,
  p: Record<string, unknown>,
  actionProof: string,
): Promise<RouteResult> {
  const { id: userId, token } = await requireUserId(authHeader);
  const id = typeof p.id === "string" ? p.id : "";
  if (!id) throw new Error("id is required");

  await actionProofStore.consume(actionProof, {
    userId,
    binding: httpActionBinding(token),
    action: "passkey.delete",
    resource: id,
  });

  const removed = await db.transaction(async (tx) => {
    // 同一ユーザの並行削除を直列化し、2本を同時に削除して0本になる競合を防ぐ。
    await tx.select({ id: schema.users.id }).from(schema.users)
      .where(eq(schema.users.id, userId)).for("update");
    const owned = await tx.select({ id: schema.passkeys.id })
      .from(schema.passkeys).where(eq(schema.passkeys.userId, userId));
    if (!owned.some((passkey) => passkey.id === id)) {
      throw AppError.notFound("Passkey not found");
    }
    if (owned.length <= 1) {
      throw AppError.conflict("The final passkey cannot be deleted");
    }
    return tx.delete(schema.passkeys)
      .where(and(eq(schema.passkeys.id, id), eq(schema.passkeys.userId, userId)))
      .returning({ id: schema.passkeys.id });
  });
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
