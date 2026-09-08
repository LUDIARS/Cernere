/**
 * Passkey (WebAuthn / FIDO2) REST ハンドラ
 *
 * 対応する認証器:
 *   - iOS / iPadOS : Face ID / Touch ID (iCloud Keychain で同期される passkey)
 *   - macOS        : Touch ID (Safari) / Chrome ProfileSync
 *   - Windows      : Windows Hello (顔/指紋/PIN)
 *   - Android      : 指紋/顔 (Google Password Manager で同期)
 *
 * 物理キー (YubiKey 等) や同期パスキーも含む WebAuthn 認証器を利用できる。
 *
 * 外部 API は一切不要 — ブラウザ <-> Cernere サーバの直接やり取り。
 *
 * 主なエンドポイント (= 登録 / ログインの begin/finish のペア):
 *   POST /api/auth/passkey/register-begin   (要 認証, 任意の nickname を受ける)
 *   POST /api/auth/passkey/register-finish  (要 認証, ブラウザ署名を verify)
 *   POST /api/auth/passkey/login-begin      (未認証, optional email)
 *   POST /api/auth/passkey/login-finish     (未認証, ブラウザ署名を verify → JWT 発行)
 *   POST /api/auth/passkey/signup-begin     (未認証, name 必須 / email 任意 → 新規登録 options)
 *   POST /api/auth/passkey/signup-finish    (未認証, verify → users+passkeys 作成 → JWT 発行)
 *   POST /api/auth/passkey/composite-login-finish  (未認証, verify → authCode 発行)
 *   POST /api/auth/passkey/composite-signup-finish (未認証, verify → 作成 → authCode 発行)
 * composite-* は埋め込み SDK / popup 用。 同じ 4 ceremony は project WS の
 * `auth.passkey-*` (executePasskeyCompositeAction) からも呼べる。
 *
 * challenge は Redis に保存して TTL 5 分。 同一ユーザは concurrent な
 * register/login を 1 件しか持てない (= 後勝ち)。
 */

import crypto from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
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
import { generateAccessToken, generateTokenPair, verifyToken, extractBearerToken, REFRESH_TOKEN_DAYS } from "../auth/jwt.js";
import { completedAuthentication } from "../lib/authentication-evidence.js";
import { assertUserSessionCurrent, type UserSessionState } from "../auth/user-session-state.js";
import { handlePasskeyRecovery } from "./passkey-recovery-handler.js";
import { hashRefreshToken } from "../auth/token-hash.js";
import {
  issueDeviceCredential,
} from "../auth/device-credential.js";
import { buildDeviceCookie } from "../auth/device-cookie.js";
import { assertDeviceOrigin } from "../auth/device-origin.js";
import { issueAuthCode } from "../auth/auth-code.js";
import { logUserLogin, logUserLoginFailed, logUserRegister } from "../logging/auth-logger.js";
import { devError, devLog } from "../logging/dev-logger.js";
import { requireExportAuth } from "./export-auth.js";
import { actionProofStore, httpActionBinding } from "../auth/action-proof.js";
import { mergeWebauthnOrigins } from "../auth/webauthn-origins.js";
import {
  passkeyAnonymousRateLimitScope,
  passkeyLoginRateLimitScope,
} from "../auth/passkey-rate-limit.js";
import { publicPasskeyCompositeError } from "../auth/passkey-public-error.js";
import { AppError } from "../error.js";

interface RouteResult { status: string; data: unknown; cookies?: string[] }
export interface RequestCtx {
  ip?: string;
  userAgent?: string;
  hostname?: string;
  origin?: string;
  /**
   * project WS (埋め込み SDK → サービス backend → Cernere) 経由の呼び出しでは、
   * 認証成立時に project_data_<key> の行を確保するために projectKey を載せる。
   * REST 直叩きでは undefined。
   */
  projectKey?: string;
}

const RP_NAME = config.webauthnRpName;
const RP_ID = config.webauthnRpId;
// 埋め込み SDK を描画する first-party サービスの origin でも ceremony が走るため、
// composite の許可 origin を expectedOrigin に合流させる (auth/webauthn-origins.ts)。
const ORIGINS = mergeWebauthnOrigins(config.webauthnOrigins, config.compositeAllowedOrigins);
const CHALLENGE_TTL_SEC = 5 * 60;

/**
 * 登録時の認証器ポリシー (3 経路 = signup / profile 追加 / 新端末登録 で共通)。
 *
 *   - residentKey "required"
 *       usernameless (メール未入力) ログインには discoverable credential が要る。
 *       "preferred" だと非 discoverable が作られ得て、 認証器が候補を出せない。
 *   - userVerification "required"
 *       出席チェックイン (Ostiarius) が assertion を userVerification:'required' で
 *       検証するため、 登録時点で UV (生体/PIN) を必須化して整合させる。 端末貸し
 *       対策が設計の核なので、 ここはセキュア方向に寄せる。
 */
const REGISTRATION_AUTHENTICATOR_SELECTION = {
  residentKey: "required",
  userVerification: "required",
} as const;

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
    case "recovery-begin": case "recovery-finish": return handlePasskeyRecovery(action, parseBody(body), ctx.ip);
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
    /* 埋め込み SDK からのパスキー新規登録。 signup-finish と同じ検証・作成を行うが
     * JWT ではなく authCode を返し、 呼び出し元サービスが exchange で受け取る。 */
    case "composite-signup-finish": return compositeSignupFinish(parseBody(body), ctx);
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

/**
 * project WS 経由で認証が成立したとき、 composite login と同じく project_data_<key>
 * の行を確保する。 REST (projectKey 無し) では何もしない。
 * project/service は http 層を import しているため、 循環を避けて動的 import する。
 */
async function ensureProjectRowForComposite(userId: string, ctx: RequestCtx): Promise<void> {
  if (!ctx.projectKey) return;
  const { ensureUserProjectRow } = await import("../project/service.js");
  await ensureUserProjectRow(userId, ctx.projectKey);
}

/** project WS (`auth.passkey-*`) から呼べる passkey ceremony の集合。 */
export type PasskeyCompositeAction =
  | "passkey-login-begin"
  | "passkey-login-finish"
  | "passkey-signup-begin"
  | "passkey-signup-finish";

export const PASSKEY_COMPOSITE_ACTIONS: readonly PasskeyCompositeAction[] = [
  "passkey-login-begin",
  "passkey-login-finish",
  "passkey-signup-begin",
  "passkey-signup-finish",
];

export function isPasskeyCompositeAction(action: string): action is PasskeyCompositeAction {
  return (PASSKEY_COMPOSITE_ACTIONS as readonly string[]).includes(action);
}

/**
 * 埋め込み SDK (<CompositeLogin>) がサービス backend → project WS 経由で passkey
 * ceremony を回すためのエントリポイント。 finish 系は JWT ではなく authCode を返す
 * (REST の composite-*-finish と同じ契約)。
 */
export async function executePasskeyCompositeAction(
  action: PasskeyCompositeAction,
  payload: Record<string, unknown>,
  ctx: RequestCtx,
): Promise<unknown> {
  try {
    switch (action) {
      case "passkey-login-begin":   return (await loginBegin(payload, ctx)).data;
      case "passkey-login-finish":  return (await compositeLoginFinish(payload, ctx)).data;
      case "passkey-signup-begin":  return (await signupBegin(payload, ctx)).data;
      case "passkey-signup-finish": return (await compositeSignupFinish(payload, ctx)).data;
    }
  } catch (error) {
    const publicError = publicPasskeyCompositeError(error);
    if (publicError !== error) {
      devError("passkey.composite.internalFailure", error, { action, projectKey: ctx.projectKey });
    }
    throw publicError;
  }
}

async function requireUserId(authHeader: string): Promise<{ id: string; role: string; token: string }> {
  const token = extractBearerToken(authHeader);
  if (!token) throw new Error("Unauthorized: missing bearer token");
  const payload = await verifyToken(token);
  if (!payload || typeof payload.sub !== "string") {
    throw new Error("Unauthorized: invalid token");
  }
  return { id: payload.sub, role: (payload.role as string) || "general", token };
}

/**
 * 生きている passkey だけを対象にする述語 (§7.1)。
 *
 * 削除を hard delete から論理失効へ移したので、 login / list /
 * excludeCredentials / counter update / export の全 query に共通適用する。
 * 1 箇所でも漏らすと、 失効させたはずの資格情報がそこだけ通ってしまう。
 */
function activePasskeysOf(userId: string) {
  return and(eq(schema.passkeys.userId, userId), isNull(schema.passkeys.revokedAt));
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
  await checkRateLimit(`passkey-signup:${passkeyAnonymousRateLimitScope(ctx)}`, 5, 600);

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
    authenticatorSelection: REGISTRATION_AUTHENTICATOR_SELECTION,
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

/** WebAuthn 検証を通ってアカウントが作成された結果。 発行物 (JWT / authCode) は呼び出し側が決める。 */
interface SignedUpAccount {
  userId: string;
  name: string;
  email: string | null;
  role: string;
}

/** ユーザ作成トランザクション内で追加処理 (refresh session の挿入等) を差し込む口。 */
type SignupTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * パスワードを作らず、最初の passkey をそのアカウントの認証資格情報として登録する。
 * ユーザー行は WebAuthn 検証が成功するまで作成しないため、途中離脱したアカウントを残さない。
 *
 * REST (JWT 返却) と composite (authCode 返却) の両 finish が共有する本体。
 * `withinTx` はユーザ・passkey 挿入と同じトランザクションで走る (原子性を保つため)。
 */
async function finalizePasskeySignup(
  p: Record<string, unknown>,
  ctx: RequestCtx,
  withinTx?: (tx: SignupTx, account: SignedUpAccount) => Promise<void>,
): Promise<SignedUpAccount> {
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
  const account: SignedUpAccount = {
    userId: pending.userId,
    name: pending.name,
    email: pending.email,
    role,
  };

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
    if (withinTx) await withinTx(tx, account);
  });

  logUserRegister(pending.userId, pending.email ?? `(passkey-only) ${pending.name}`, "passkey", { ip: ctx.ip });
  return account;
}

/** REST: 作成したアカウントの JWT ペアを返す (Cernere 自身の /login や device 登録が使う)。 */
async function signupFinish(p: Record<string, unknown>, ctx: RequestCtx): Promise<RouteResult> {
  let tokens: Awaited<ReturnType<typeof generateTokenPair>> | null = null;
  const account = await finalizePasskeySignup(p, ctx, async (tx, created) => {
    tokens = await generateTokenPair(created.userId, created.role, undefined, { database: tx });
    await tx.insert(schema.refreshSessions).values({
      authEpoch: tokens.authEpoch, id: crypto.randomUUID(),
      userId: created.userId,
      refreshToken: hashRefreshToken(tokens.refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000),
    });
  });
  // withinTx は transaction 成功時に必ず走るため、 ここで null なら実装上の不整合。
  if (!tokens) throw new Error("Passkey signup did not issue a session");
  const issued: { accessToken: string; refreshToken: string } = tokens;
  return {
    status: "201 Created",
    data: {
      user: {
        id: account.userId,
        displayName: account.name,
        email: account.email,
        role: account.role,
      },
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
    },
  };
}

/**
 * composite (埋め込み SDK / popup) 用 passkey signup finish: JWT は返さず authCode を発行する。
 * 呼び出し元サービスは自分の backend 経由で /api/auth/exchange して service_token を得る。
 */
async function compositeSignupFinish(p: Record<string, unknown>, ctx: RequestCtx): Promise<RouteResult> {
  const account = await finalizePasskeySignup(p, ctx);
  try {
    await ensureProjectRowForComposite(account.userId, ctx);
    const authCode = await issueAuthCode({
      userId: account.userId,
      displayName: account.name,
      email: account.email,
      role: account.role,
    });
    return { status: "201 Created", data: { authCode } };
  } catch {
    // WebAuthn 検証と user/passkey 作成は既に commit 済み。一般的な「登録失敗」に
    // すると同じ signupId を再送しても回復できないため、作成済みであることと
    // 新しい passkey で login できる復旧手順を明示する。内部障害の詳細は返さない。
    throw new Error(
      "Account creation completed, but sign-in completion failed. Return to login and use your new passkey.",
    );
  }
}

async function registerBegin(authHeader: string, actionProof: string): Promise<RouteResult> {
  const { id: userId, token } = await requireUserId(authHeader);
  const user = (await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1))[0];
  if (!user) throw new Error("Unauthorized: user not found");

  // 既存クレデンシャル (= 同じ認証器を 2 重登録させない)
  const existing = await db.select({
    credentialId: schema.passkeys.credentialId,
    transports: schema.passkeys.transports,
  }).from(schema.passkeys).where(activePasskeysOf(userId));

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
    authenticatorSelection: REGISTRATION_AUTHENTICATOR_SELECTION,
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
  // project WS では email もサービスが自由に変えられるため、常に authenticated
  // projectKey を使う。REST は従来どおり対象 email、usernameless は接続元 IP。
  const loginLimitScope = passkeyLoginRateLimitScope(email, ctx);
  await checkRateLimit(`passkey-login:${loginLimitScope}`, 30, 900);

  let allowCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] | undefined;
  let challengeOwner = "anon:" + crypto.randomUUID();

  if (email) {
    const user = (await db.select({ id: schema.users.id })
      .from(schema.users).where(eq(schema.users.email, email)).limit(1))[0];
    if (user) {
      const rows = await db.select({
        credentialId: schema.passkeys.credentialId,
        transports: schema.passkeys.transports,
      }).from(schema.passkeys).where(activePasskeysOf(user.id));
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
  /** 認証に使われた passkey 行。 発行する Device Credential の root として記録する。 */
  passkeyId: string;
  verifiedAt: number;
}> {
  const response = p.response as AuthenticationResponseJSON | undefined;
  const challengeOwner = typeof p.challengeOwner === "string" ? p.challengeOwner : "";
  if (!response) throw new Error("response is required");
  if (!challengeOwner) throw new Error("challengeOwner is required");

  const expectedChallenge = await redis.getdel(challengeKey("login", challengeOwner));
  if (!expectedChallenge) throw new Error("Challenge expired or missing — please retry");

  // 提示された credential.id (= base64url) で passkey を DB から引く
  // 論理失効済み passkey では認証させない (§7.1)。 hard delete をやめた分、
  // ここで弾かないと失効済みの資格情報でログインできてしまう。
  const cred = (await db.select().from(schema.passkeys)
    .where(and(
      eq(schema.passkeys.credentialId, response.id),
      isNull(schema.passkeys.revokedAt),
    )).limit(1))[0];
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

  const verifiedAt = Date.now();
  const newCounter = verification.authenticationInfo.newCounter;
  const user = await db.transaction(async tx => {
    // Serialize with passkey deletion and recovery, then re-check the verified credential.
    const current = (await tx.select().from(schema.users).where(eq(schema.users.id, cred.userId)).for("update"))[0];
    const active = (await tx.select().from(schema.passkeys)
      .where(and(eq(schema.passkeys.id, cred.id), isNull(schema.passkeys.revokedAt))).limit(1))[0];
    if (!current || !active || active.userId !== current.id || Number(active.counter) !== Number(cred.counter)) {
      throw AppError.unauthorized("Passkey authorization changed; authenticate again");
    }
    await tx.update(schema.passkeys).set({ counter: newCounter, lastUsedAt: new Date() }).where(eq(schema.passkeys.id, active.id));
    await tx.update(schema.users).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(schema.users.id, current.id));
    return current;
  });
  return { user, challengeOwner, passkeyId: cred.id, verifiedAt };
}

async function loginFinish(p: Record<string, unknown>, ctx: RequestCtx): Promise<RouteResult> {
  const { user, passkeyId, verifiedAt } = await verifyPasskeyAssertion(p, ctx);
  const authentication = completedAuthentication("passkey", user.mfaRevision, verifiedAt);
  if (config.deviceSessionsEnabled && p.deviceSession === true) {
    if (!ctx.hostname) throw AppError.forbidden("Browser device context required");
    assertDeviceOrigin(ctx.origin ?? "");
    const issued = await issueDeviceCredential({ userId: user.id, rootPasskeyId: passkeyId, clientKind: "browser", authentication, authEpoch: user.authEpoch });
    const accessToken = await generateAccessToken(user.id, user.role, authentication, { deviceId: issued.deviceId, authEpoch: user.authEpoch });
    return { status: "200 OK", cookies: [buildDeviceCookie(issued.token, ctx.hostname, issued.expiresAt)], data: {
      user: { id: user.id, login: user.login, displayName: user.displayName, email: user.email, role: user.role, avatarUrl: user.avatarUrl },
      accessToken, refreshToken: "", deviceSession: true,
    } };
  }
  const { accessToken, refreshToken, authEpoch } = await generateTokenPair(user.id, user.role, authentication, { authEpoch: user.authEpoch });
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(schema.refreshSessions).values({
    authEpoch, id: crypto.randomUUID(), userId: user.id, refreshToken: hashRefreshToken(refreshToken), expiresAt, authentication,
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
  const { user, verifiedAt } = await verifyPasskeyAssertion(p, ctx);
  await ensureProjectRowForComposite(user.id, ctx);
  const authCode = await issueAuthCode({
    userId: user.id,
    displayName: user.displayName,
    email: user.email,
    role: user.role ?? "general",
    authentication: completedAuthentication("passkey", user.mfaRevision, verifiedAt),
    authEpoch: user.authEpoch,
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
  const authorization = await verifyToken(bearer);
  const user = (await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1))[0];
  if (!user) throw new Error("Unauthorized: user not found");
  await checkRateLimit(`passkey-device-link:${userId}`, 5, 600);

  // passkey を既に持つユーザには fresh step-up を要求する (register-begin と同じ方針)。
  // パスワード/OAuth のみのユーザは step-up に使える passkey が無いため bootstrap 扱い。
  const existing = await db.select({ id: schema.passkeys.id })
    .from(schema.passkeys).where(activePasskeysOf(userId));
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
    JSON.stringify({ userId, authorization }),
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
  const { userId, authorization } = JSON.parse(raw) as { userId: string; authorization?: UserSessionState };
  if (!authorization || authorization.sub !== userId) throw AppError.unauthorized("Registration link must be reissued");
  await assertUserSessionCurrent(authorization);

  const user = (await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1))[0];
  if (!user) throw new Error("Registration link is invalid, expired, or already used");

  const existing = await db.select({
    credentialId: schema.passkeys.credentialId,
    transports: schema.passkeys.transports,
  }).from(schema.passkeys).where(activePasskeysOf(userId));

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
    authenticatorSelection: REGISTRATION_AUTHENTICATOR_SELECTION,
  });

  const ceremonyId = crypto.randomUUID();
  await redis.set(
    deviceRegisterKey(ceremonyId),
    JSON.stringify({ challenge: options.challenge, userId, authorization }),
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
  const pending = JSON.parse(raw) as { challenge: string; userId: string; authorization?: UserSessionState };
  if (!pending.authorization || pending.authorization.sub !== pending.userId) throw AppError.unauthorized("Registration link must be reissued");

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
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);

  const { accessToken, refreshToken } = await db.transaction(async (tx) => {
    await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, user.id)).for("update");
    await assertUserSessionCurrent(pending.authorization!, tx);
    const authentication = completedAuthentication("passkey", user.mfaRevision, now.getTime());
    const tokens = await generateTokenPair(user.id, user.role, authentication, { authEpoch: pending.authorization!.authEpoch, database: tx });
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
      authEpoch: tokens.authEpoch, authentication, id: crypto.randomUUID(),
      userId: user.id,
      refreshToken: hashRefreshToken(tokens.refreshToken),
      expiresAt,
    });
    return tokens;
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
    .where(activePasskeysOf(userId))
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
      .from(schema.passkeys).where(activePasskeysOf(userId));
    if (!owned.some((passkey) => passkey.id === id)) {
      throw AppError.notFound("Passkey not found");
    }
    if (owned.length <= 1) {
      throw AppError.conflict("The final passkey cannot be deleted");
    }
    // hard delete をやめ論理失効にする (§7.1)。 行を残すのは、 どの端末が
    // どの passkey 由来かを後から辿れないと失効連動も監査もできないため。
    const changed = await tx.update(schema.passkeys)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(schema.passkeys.id, id),
        eq(schema.passkeys.userId, userId),
        isNull(schema.passkeys.revokedAt),
      ))
      .returning({ id: schema.passkeys.id });
    await tx.update(schema.deviceCredentials).set({ revokedAt: new Date(), revokedReason: "passkey_revoked" }).where(eq(schema.deviceCredentials.rootPasskeyId, id));
    return changed;
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
  const params = new URLSearchParams(query);
  const project = params.get("project") ?? undefined;
  const rawFacilityId = params.get("facilityId") ?? undefined;
  const parsedFacilityId = z.string().uuid().optional().safeParse(rawFacilityId);
  if (!parsedFacilityId.success) throw AppError.badRequest("facilityId must be a UUID");
  const facilityId = parsedFacilityId.data;

  const rows = await db.select({
    userId: schema.passkeys.userId,
    credentialId: schema.passkeys.credentialId,
    publicKey: schema.passkeys.publicKey,
    counter: schema.passkeys.counter,
    transports: schema.passkeys.transports,
  }).from(schema.passkeys).where(isNull(schema.passkeys.revokedAt));

  const userIds = [...new Set(rows.map((r) => r.userId))];
  const memberships = userIds.length === 0 ? [] : await db.select({
    userId: schema.organizationMembers.userId,
    facilityId: schema.organizationMembers.organizationId,
    role: schema.organizationMembers.role,
  }).from(schema.organizationMembers).where(inArray(schema.organizationMembers.userId, userIds));
  const membershipByUser = new Map<string, typeof memberships>();
  for (const membership of memberships) {
    const list = membershipByUser.get(membership.userId) ?? [];
    list.push(membership); membershipByUser.set(membership.userId, list);
  }

  const credentials = rows
    .filter((r) => !facilityId || membershipByUser.get(r.userId)?.some((m) => m.facilityId === facilityId))
    .map((r) => {
      // 施設指定時に、同じユーザーが所属する別施設の ID / role を漏らさない。
      const visibleMemberships = (membershipByUser.get(r.userId) ?? [])
        .filter((membership) => !facilityId || membership.facilityId === facilityId);
      return {
        userId: r.userId,
        credentialId: r.credentialId,                              // base64url (登録時のまま)
        publicKey: Buffer.from(r.publicKey).toString("base64"),   // COSE bytes → base64
        counter: Number(r.counter),
        transports: Array.isArray(r.transports) ? (r.transports as string[]) : [],
        roles: [...new Set(visibleMemberships.map((m) => m.role))],
        facilityIds: [...new Set(visibleMemberships.map((m) => m.facilityId))],
      };
    });

  devLog("passkey.export", { count: credentials.length, project: project ?? null, facilityId: facilityId ?? null });
  return { status: "200 OK", data: { credentials } };
}
