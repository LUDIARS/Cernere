/**
 * Auth REST ハンドラ (フレームワーク非依存)
 *
 * uWS の HTTP ルートから呼ばれる純粋な関数。
 * 入力: action名, body文字列, authHeader → 出力: { status, data }
 */

import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import {
  generateTokenPair, generateToolToken, generateProjectToken, verifyToken, verifyProjectToken, extractBearerToken, REFRESH_TOKEN_DAYS,
} from "../auth/jwt.js";
import { hashRefreshToken } from "../auth/token-hash.js";
import { isPasetoEnabled, signProjectToken } from "../auth/paseto.js";
import { checkRateLimit, redis } from "../redis.js";
import {
  logUserLogin,
  logUserLoginFailed,
  logUserRegister,
  logProjectLogin,
  logProjectLoginFailed,
} from "../logging/auth-logger.js";
import { devLog } from "../logging/dev-logger.js";

interface RouteResult {
  status: string;
  data: unknown;
}

export interface RequestCtx {
  ip?: string;
  userAgent?: string;
}

export async function handleAuthRoute(
  action: string,
  body: string,
  authHeader: string,
  ctx: RequestCtx = {},
): Promise<RouteResult> {
  devLog("auth.route", { action, ip: ctx.ip });
  switch (action) {
    case "register": return register(parseBody(body), ctx);
    case "login": return login(parseBody(body), ctx);
    case "refresh": return refresh(parseBody(body));
    case "logout": return logout(parseBody(body));
    case "verify": return verify(parseBody(body), ctx);
    case "exchange": return exchange(parseBody(body));
    case "me": return me(authHeader);
    case "project-token": return projectUserToken(parseBody(body), authHeader, ctx);
    default:
      return { status: "404 Not Found", data: { error: `Unknown auth action: ${action}` } };
  }
}

function parseBody(body: string): Record<string, unknown> {
  if (!body) return {};
  try { return JSON.parse(body); } catch { return {}; }
}

async function register(p: Record<string, unknown>, ctx: RequestCtx): Promise<RouteResult> {
  const name = p.name as string | undefined;
  const email = p.email as string | undefined;
  const password = p.password as string | undefined;
  devLog("auth.register.begin", { email, ip: ctx.ip });

  if (!name || !email || !password) throw new Error("name, email, password are required");
  if (password.length < 8) throw new Error("Password must be at least 8 characters");

  devLog("auth.register.rateLimit", { email });
  await checkRateLimit(`register:${email}`, 5, 600);

  devLog("auth.register.checkExisting", { email });
  const existing = await db.select({ id: schema.users.id })
    .from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (existing.length > 0) throw new Error("Registration failed. Please check your input and try again.");

  devLog("auth.register.hashPassword");
  const passwordHash = await bcrypt.hash(password, 12);
  const countResult = await db.select({ count: sql<number>`count(*)` }).from(schema.users);
  const role = Number(countResult[0]?.count ?? 0) === 0 ? "admin" : "general";
  const userId = crypto.randomUUID();
  const now = new Date();

  devLog("auth.register.insertUser", { userId, role });
  await db.insert(schema.users).values({
    id: userId, login: name, displayName: name, email, role, passwordHash,
    createdAt: now, updatedAt: now,
  });

  const { accessToken, refreshToken } = generateTokenPair(userId, role);
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(schema.refreshSessions).values({
    id: crypto.randomUUID(), userId, refreshToken: hashRefreshToken(refreshToken), expiresAt,
  });

  logUserRegister(userId, email, "email", { ip: ctx.ip });

  return {
    status: "201 Created",
    data: {
      user: { id: userId, displayName: name, email, role },
      accessToken, refreshToken,
    },
  };
}

async function login(p: Record<string, unknown>, ctx: RequestCtx): Promise<RouteResult> {
  // Tool client login
  if (p.grant_type === "client_credentials") {
    devLog("auth.login.toolClient", { clientId: p.client_id });
    return toolLogin(p.client_id as string, p.client_secret as string);
  }
  // Project login (managed_projects)
  if (p.grant_type === "project_credentials") {
    devLog("auth.login.project", { clientId: p.client_id });
    return projectLogin(p.client_id as string, p.client_secret as string, ctx);
  }

  const email = p.email as string | undefined;
  const password = p.password as string | undefined;
  devLog("auth.login.user.begin", { email, ip: ctx.ip });
  if (!email || !password) {
    logUserLoginFailed(email, "email", "missing credentials", ctx);
    throw new Error("email and password are required");
  }

  devLog("auth.login.user.rateLimit", { email });
  await checkRateLimit(`login:${email}`, 10, 900);

  devLog("auth.login.user.lookup", { email });
  const rows = await db.select().from(schema.users)
    .where(eq(schema.users.email, email)).limit(1);
  const user = rows[0];
  if (!user || !user.passwordHash) {
    devLog("auth.login.user.notFound", { email });
    logUserLoginFailed(email, "email", "invalid credentials", ctx);
    throw new Error("Unauthorized: Invalid email or password");
  }

  devLog("auth.login.user.verify", { userId: user.id });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    devLog("auth.login.user.invalid", { userId: user.id });
    logUserLoginFailed(email, "email", "invalid credentials", ctx);
    throw new Error("Unauthorized: Invalid email or password");
  }

  if (user.mfaEnabled) {
    return { status: "200 OK", data: { mfaRequired: true, mfaMethods: user.mfaMethods ?? [] } };
  }

  const now = new Date();
  await db.update(schema.users).set({ lastLoginAt: now, updatedAt: now })
    .where(eq(schema.users.id, user.id));

  const { accessToken, refreshToken } = generateTokenPair(user.id, user.role);
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(schema.refreshSessions).values({
    id: crypto.randomUUID(), userId: user.id, refreshToken: hashRefreshToken(refreshToken), expiresAt,
  });

  logUserLogin(user.id, user.email, "email", ctx);

  return {
    status: "200 OK",
    data: {
      user: { id: user.id, displayName: user.displayName, email: user.email, role: user.role },
      accessToken, refreshToken,
    },
  };
}

async function refresh(p: Record<string, unknown>): Promise<RouteResult> {
  const rt = p.refreshToken as string | undefined;
  if (!rt) throw new Error("refreshToken is required");

  const rows = await db.select().from(schema.refreshSessions)
    .where(eq(schema.refreshSessions.refreshToken, hashRefreshToken(rt))).limit(1);
  const session = rows[0];
  if (!session || new Date() > session.expiresAt) throw new Error("Unauthorized: Invalid or expired refresh token");

  const userRows = await db.select().from(schema.users)
    .where(eq(schema.users.id, session.userId)).limit(1);
  if (!userRows[0]) throw new Error("Unauthorized: User not found");

  const { accessToken, refreshToken } = generateTokenPair(userRows[0].id, userRows[0].role);
  await db.update(schema.refreshSessions)
    .set({ refreshToken: hashRefreshToken(refreshToken) }).where(eq(schema.refreshSessions.id, session.id));

  return { status: "200 OK", data: { accessToken, refreshToken } };
}

async function logout(p: Record<string, unknown>): Promise<RouteResult> {
  const rt = p.refreshToken as string | undefined;
  if (rt) {
    await db.delete(schema.refreshSessions)
      .where(eq(schema.refreshSessions.refreshToken, hashRefreshToken(rt)));
  }
  return { status: "200 OK", data: { message: "Logged out" } };
}

async function verify(p: Record<string, unknown>, ctx: RequestCtx): Promise<RouteResult> {
  // verify は token 文字列の有効性 oracle になりうるため rate limit を課す
  // (M-1: login/register には rate limit があるのに verify には無かった非対称を解消)。
  await checkRateLimit(`verify:${ctx.ip ?? "unknown"}`, 60, 60);
  const token = p.token as string;
  // プロジェクトトークンとして検証
  try {
    const claims = verifyProjectToken(token);
    const rows = await db.select().from(schema.managedProjects)
      .where(eq(schema.managedProjects.clientId, claims.sub)).limit(1);
    const project = rows[0];
    if (!project || !project.isActive) return { status: "200 OK", data: { valid: false } };
    return {
      status: "200 OK",
      data: {
        valid: true,
        tokenType: "project",
        project: { key: project.key, name: project.name, clientId: project.clientId },
      },
    };
  } catch { /* fall through to user token */ }
  // ユーザートークンとして検証
  try {
    const claims = verifyToken(token);
    const rows = await db.select().from(schema.users)
      .where(eq(schema.users.id, claims.sub)).limit(1);
    if (!rows[0]) return { status: "200 OK", data: { valid: false } };
    return {
      status: "200 OK",
      data: {
        valid: true,
        tokenType: "user",
        user: { id: rows[0].id, name: rows[0].displayName, email: rows[0].email, role: rows[0].role },
      },
    };
  } catch {
    return { status: "200 OK", data: { valid: false } };
  }
}

async function exchange(p: Record<string, unknown>): Promise<RouteResult> {
  // M-3: authcode は user の access/refresh token を取り出す bearer ticket。
  // 以前は code の先頭 8 文字を平文 console.log に書いていた。 値はログに残さず、
  // dev のみ有効な devLog に「有無 / 結果」だけを寄せる。
  const code = p.code as string | undefined;
  if (!code) {
    devLog("auth.exchange.missingCode", {});
    throw new Error("code is required");
  }
  const raw = await redis.get(`authcode:${code}`);
  devLog("auth.exchange.lookup", { found: raw !== null });
  if (!raw) throw new Error("Unauthorized: Invalid or expired auth code");
  await redis.del(`authcode:${code}`);
  const parsed = JSON.parse(raw);
  devLog("auth.exchange.done", {
    userId: parsed.user?.id ?? "(none)",
    hasAccessToken: !!parsed.accessToken,
  });
  return { status: "200 OK", data: parsed };
}

async function me(authHeader: string): Promise<RouteResult> {
  const token = extractBearerToken(authHeader);
  if (!token) throw new Error("Unauthorized: No token provided");
  const claims = verifyToken(token);
  const rows = await db.select().from(schema.users)
    .where(eq(schema.users.id, claims.sub)).limit(1);
  if (!rows[0]) throw new Error("Unauthorized: User not found");
  const u = rows[0];
  return {
    status: "200 OK",
    data: {
      id: u.id, name: u.displayName, email: u.email, role: u.role,
      hasGoogleAuth: !!u.googleId, hasPassword: !!u.passwordHash,
      googleScopes: u.googleScopes ?? [],
    },
  };
}

/**
 * POST /api/auth/project-token  — 「ログイン中ユーザ × 指定 project」 の per-call token を発行。
 *
 * リクエスト:
 *   Authorization: Bearer <user accessToken>
 *   body: { project_key: "memoria-hub" }   (project_id でも可: 後方互換)
 *
 * 戻り値:
 *   { tokenType: "user_for_project", accessToken, expiresIn, projectKey, userId }
 *
 * 設計意図:
 *   ・呼び出し元 (Memoria local backend など) は **自分用の long-lived secret を持たない**。
 *     ログイン中ユーザの user JWT を借りて、 各 project に対する short-lived token を都度発行する。
 *   ・返した token は呼び出し元 process の memory のみに保持される想定。 disk / Infisical
 *     には残さない。 user/AI も値を見ない (HTTPS+memory 経由でのみ流通)。
 *   ・token は **PASETO Ed25519 (aud=hub_url 必須)** で署名する。 project 側 (Hub) は
 *     `/.well-known/cernere-public-key` の公開鍵でローカル検証する。 旧 HS256 共有鍵
 *     fallback は鍵横展開 + aud 無し横断偽造のリスクのため撤去済み。
 */
async function projectUserToken(
  p: Record<string, unknown>,
  authHeader: string,
  ctx: RequestCtx,
): Promise<RouteResult> {
  const token = extractBearerToken(authHeader);
  if (!token) throw new Error("Unauthorized: No token provided");
  const claims = verifyToken(token);

  const projectKey = (p.project_key as string | undefined) ?? (p.project_id as string | undefined);
  if (!projectKey || typeof projectKey !== "string") {
    throw new Error("project_key is required");
  }

  await checkRateLimit(`project_user_token:${claims.sub}:${projectKey}`, 60, 60);

  const rows = await db.select().from(schema.managedProjects)
    .where(eq(schema.managedProjects.key, projectKey)).limit(1);
  const project = rows[0];
  if (!project || !project.isActive) {
    throw new Error(`project '${projectKey}' not found or inactive`);
  }

  const userRows = await db.select().from(schema.users)
    .where(eq(schema.users.id, claims.sub)).limit(1);
  if (!userRows[0]) throw new Error("Unauthorized: User not found");
  const user = userRows[0];

  // hub_url (= 受け取る service の URL) を PASETO の aud claim に入れる。 これは
  // confused-deputy 防御の要 (「service A 向け token を service B が受理」を防ぐ) なので
  // **必須**。 旧 HS256 fallback は撤去したため、 未指定/PASETO 未設定は fail-closed。
  const hubUrl = typeof p.hub_url === "string" ? p.hub_url.trim() : "";
  const displayName = (user.displayName ?? user.login ?? "").trim() || `user-${user.id.slice(0, 8)}`;

  // fail-closed: aud 無し token は横断偽造を許すため、 hub_url を必須にする (400)。
  if (!hubUrl) {
    throw new Error("hub_url is required for project-token (HS256 fallback removed; aud is mandatory)");
  }
  // fail-closed: PASETO 署名鍵が未設定なら暗黙降格せず明示的に拒否する (= 設定不備の
  // 無言フォールバック禁止 RULE §7.1)。 サーバ構成エラーなので 500 扱い。
  if (!isPasetoEnabled()) {
    throw new Error(
      "project-token signing unavailable: PASETO keys not configured (set CERNERE_PASETO_SECRET_KEY / _PUBLIC_KEY)",
    );
  }

  const tokenTtl = 15 * 60;
  const accessToken = await signProjectToken({
    userId: user.id,
    projectKey: project.key,
    role: user.role,
    displayName,
    audience: hubUrl,
    ttlSec: tokenTtl,
  });
  devLog("auth.projectUserToken.issue", {
    userId: user.id, projectKey: project.key, audience: hubUrl, ip: ctx.ip, alg: "EdDSA",
  });
  return {
    status: "200 OK",
    data: {
      tokenType: "user_for_project",
      accessToken,
      expiresIn: tokenTtl,
      projectKey: project.key,
      userId: user.id,
      displayName,
      audience: hubUrl,
      alg: "EdDSA",
    },
  };
}

async function toolLogin(clientId: string | undefined, clientSecret: string | undefined): Promise<RouteResult> {
  if (!clientId || !clientSecret) throw new Error("client_id and client_secret are required");
  const rows = await db.select().from(schema.toolClients)
    .where(eq(schema.toolClients.clientId, clientId)).limit(1);
  const tc = rows[0];
  if (!tc || !tc.isActive) throw new Error("Unauthorized: Invalid client credentials");
  const valid = await bcrypt.compare(clientSecret, tc.clientSecretHash);
  if (!valid) throw new Error("Unauthorized: Invalid client credentials");
  const scopes = (tc.scopes as string[]) ?? [];
  const accessToken = generateToolToken(tc.id, tc.ownerUserId, scopes);
  await db.update(schema.toolClients).set({ lastUsedAt: new Date() })
    .where(eq(schema.toolClients.id, tc.id));
  return {
    status: "200 OK",
    data: { tokenType: "tool", accessToken, expiresIn: 3600, client: { id: tc.id, name: tc.name, clientId: tc.clientId, ownerUserId: tc.ownerUserId, scopes, isActive: tc.isActive } },
  };
}

async function projectLogin(clientId: string | undefined, clientSecret: string | undefined, ctx: RequestCtx): Promise<RouteResult> {
  if (!clientId || !clientSecret) {
    logProjectLoginFailed(clientId, "missing credentials", ctx);
    throw new Error("client_id and client_secret are required");
  }
  await checkRateLimit(`project_login:${clientId}`, 10, 300);
  const rows = await db.select().from(schema.managedProjects)
    .where(eq(schema.managedProjects.clientId, clientId)).limit(1);
  const project = rows[0];
  if (!project || !project.isActive) {
    logProjectLoginFailed(clientId, "invalid credentials or project inactive", ctx);
    throw new Error("Unauthorized: Invalid project credentials");
  }
  const valid = await bcrypt.compare(clientSecret, project.clientSecretHash);
  if (!valid) {
    logProjectLoginFailed(clientId, "invalid credentials", ctx);
    throw new Error("Unauthorized: Invalid project credentials");
  }
  const accessToken = generateProjectToken(project.clientId, project.key);
  logProjectLogin(project.key, project.clientId, ctx);
  return {
    status: "200 OK",
    data: {
      tokenType: "project",
      accessToken,
      expiresIn: 3600,
      project: {
        key: project.key,
        name: project.name,
        clientId: project.clientId,
        isActive: project.isActive,
      },
    },
  };
}
