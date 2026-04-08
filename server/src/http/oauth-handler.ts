/**
 * OAuth ハンドラ (uWebSockets.js 用)
 *
 * GitHub / Google OAuth のリダイレクト + コールバックを処理する。
 * Cookie は Set-Cookie ヘッダーで手動管理。
 */

import type uWS from "uWebSockets.js";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { config } from "../config.js";
import { generateTokenPair, REFRESH_TOKEN_DAYS } from "../auth/jwt.js";
import { redis, SESSION_TTL_SECS } from "../redis.js";

const CSRF_COOKIE = "cernere_csrf_state";
const SESSION_COOKIE = "ars_session";

function getCookie(cookieHeader: string, name: string): string | undefined {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

function setCookieHeader(name: string, value: string, maxAge: number, httpOnly = true): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", `Max-Age=${maxAge}`, "SameSite=Lax"];
  if (httpOnly) parts.push("HttpOnly");
  if (config.isHttps) parts.push("Secure");
  return parts.join("; ");
}

function deleteCookieHeader(name: string): string {
  return `${name}=; Path=/; Max-Age=0`;
}

function redirect(res: uWS.HttpResponse, url: string, cookies: string[] = []): void {
  res.cork(() => {
    res.writeStatus("302 Found").writeHeader("Location", url);
    for (const c of cookies) res.writeHeader("Set-Cookie", c);
    res.end();
  });
}

export function handleOAuthRoute(
  res: uWS.HttpResponse,
  req: uWS.HttpRequest,
  provider: "github" | "google",
  action: "login" | "callback",
): void {
  // onAborted 必須
  let aborted = false;
  res.onAborted(() => { aborted = true; });

  const query = req.getQuery();
  const cookieHeader = req.getHeader("cookie") ?? "";

  // 非同期処理
  (async () => {
    try {
      if (provider === "github" && action === "login") {
        await githubLogin(res, aborted);
      } else if (provider === "github" && action === "callback") {
        await githubCallback(res, query, cookieHeader, aborted);
      } else if (provider === "google" && action === "login") {
        await googleLogin(res, aborted);
      } else if (provider === "google" && action === "callback") {
        await googleCallback(res, query, cookieHeader, aborted);
      }
    } catch (err) {
      if (aborted) return;
      redirect(res, `${config.frontendUrl}?authError=${encodeURIComponent((err as Error).message)}`);
    }
  })();
}

// ── GitHub ─────────────────────────────────────────────────

async function githubLogin(res: uWS.HttpResponse, aborted: boolean): Promise<void> {
  if (!config.githubClientId) throw new Error("GitHub OAuth is not configured");

  const csrfState = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: config.githubClientId,
    redirect_uri: config.githubRedirectUri,
    scope: "read:user user:email repo",
    state: csrfState,
  });

  if (aborted) return;
  redirect(res, `https://github.com/login/oauth/authorize?${params}`, [
    setCookieHeader(CSRF_COOKIE, csrfState, 600),
  ]);
}

async function githubCallback(res: uWS.HttpResponse, query: string, cookieHeader: string, aborted: boolean): Promise<void> {
  const params = new URLSearchParams(query);
  const code = params.get("code");
  const stateParam = params.get("state");
  const expectedState = getCookie(cookieHeader, CSRF_COOKIE);
  const frontend = config.frontendUrl;

  if (!stateParam || (!stateParam.startsWith("link:") && expectedState !== stateParam)) {
    throw new Error("Invalid OAuth state");
  }
  if (!code) throw new Error("Authorization code not provided");

  // Exchange code for token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code,
      redirect_uri: config.githubRedirectUri,
    }),
  });
  const tokenData = (await tokenRes.json()) as { access_token: string };

  // Fetch GitHub user
  const ghUserRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "Cernere" },
  });
  const ghUser = (await ghUserRes.json()) as {
    id: number; login: string; name: string | null; avatar_url: string; email: string | null;
  };

  const now = new Date();

  // Account linking
  if (stateParam.startsWith("link:")) {
    const linkUserId = stateParam.split(":")[1];
    const existing = await db.select().from(schema.users)
      .where(eq(schema.users.githubId, ghUser.id)).limit(1);
    if (existing.length > 0 && existing[0].id !== linkUserId) {
      if (aborted) return;
      redirect(res, `${frontend}?authError=${encodeURIComponent("This GitHub account is already linked to another user")}`);
      return;
    }
    await db.update(schema.users).set({ githubId: ghUser.id, updatedAt: now })
      .where(eq(schema.users.id, linkUserId));
    if (aborted) return;
    redirect(res, `${frontend}?linked=github`);
    return;
  }

  // Find or create user
  let userId: string;
  const userRows = await db.select().from(schema.users)
    .where(eq(schema.users.githubId, ghUser.id)).limit(1);

  if (userRows.length > 0) {
    userId = userRows[0].id;
    await db.update(schema.users).set({
      login: ghUser.login, displayName: ghUser.name ?? ghUser.login,
      avatarUrl: ghUser.avatar_url, email: ghUser.email,
      lastLoginAt: now, updatedAt: now,
    }).where(eq(schema.users.id, userId));
  } else {
    const countResult = await db.select({ count: sql<number>`count(*)` }).from(schema.users);
    const role = Number(countResult[0]?.count ?? 0) === 0 ? "admin" : "general";
    userId = crypto.randomUUID();
    await db.insert(schema.users).values({
      id: userId, githubId: ghUser.id, login: ghUser.login,
      displayName: ghUser.name ?? ghUser.login, avatarUrl: ghUser.avatar_url,
      email: ghUser.email, role, lastLoginAt: now, createdAt: now, updatedAt: now,
    });
  }

  // Redis session
  const sessionId = crypto.randomUUID();
  await redis.set(`session:${sessionId}`, JSON.stringify({
    id: sessionId, userId, expiresAt: new Date(Date.now() + SESSION_TTL_SECS * 1000).toISOString(),
    accessToken: tokenData.access_token,
  }), "EX", SESSION_TTL_SECS);

  if (aborted) return;
  redirect(res, "/", [
    deleteCookieHeader(CSRF_COOKIE),
    setCookieHeader(SESSION_COOKIE, sessionId, SESSION_TTL_SECS),
  ]);
}

// ── Google ────────────────────────────────────────────────

async function googleLogin(res: uWS.HttpResponse, aborted: boolean): Promise<void> {
  if (!config.googleClientId) throw new Error("Google OAuth is not configured");

  const csrfState = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.googleRedirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: csrfState,
    access_type: "offline",
    prompt: "consent",
  });

  if (aborted) return;
  redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params}`, [
    setCookieHeader(CSRF_COOKIE, csrfState, 600),
  ]);
}

async function googleCallback(res: uWS.HttpResponse, query: string, cookieHeader: string, aborted: boolean): Promise<void> {
  const params = new URLSearchParams(query);
  const code = params.get("code");
  const stateParam = params.get("state");
  const expectedState = getCookie(cookieHeader, CSRF_COOKIE);
  const frontend = config.frontendUrl;

  if (!stateParam || expectedState !== stateParam) throw new Error("Invalid OAuth state");
  if (!code) throw new Error("Authorization code not provided");

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: config.googleClientId, client_secret: config.googleClientSecret,
      redirect_uri: config.googleRedirectUri, grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    if (aborted) return;
    redirect(res, `${frontend}?authError=${encodeURIComponent("Failed to exchange authorization code")}`);
    return;
  }
  const tokenData = (await tokenRes.json()) as {
    access_token: string; refresh_token?: string; expires_in: number;
  };

  // Fetch Google user
  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const gUser = (await userRes.json()) as {
    id: string; email: string; name: string; picture: string;
  };

  const now = new Date();

  // Find or create user
  let userId: string;
  let userRole: string;
  const userRows = await db.select().from(schema.users)
    .where(eq(schema.users.googleId, gUser.id)).limit(1);

  if (userRows.length > 0) {
    userId = userRows[0].id;
    userRole = userRows[0].role;
    await db.update(schema.users).set({
      displayName: gUser.name, avatarUrl: gUser.picture, email: gUser.email,
      googleAccessToken: tokenData.access_token,
      googleRefreshToken: tokenData.refresh_token ?? userRows[0].googleRefreshToken,
      googleTokenExpiresAt: Math.floor(Date.now() / 1000) + tokenData.expires_in,
      lastLoginAt: now, updatedAt: now,
    }).where(eq(schema.users.id, userId));
  } else {
    const countResult = await db.select({ count: sql<number>`count(*)` }).from(schema.users);
    userRole = Number(countResult[0]?.count ?? 0) === 0 ? "admin" : "general";
    userId = crypto.randomUUID();
    await db.insert(schema.users).values({
      id: userId, googleId: gUser.id, login: gUser.email.split("@")[0],
      displayName: gUser.name, avatarUrl: gUser.picture, email: gUser.email,
      role: userRole, googleAccessToken: tokenData.access_token,
      googleRefreshToken: tokenData.refresh_token,
      googleTokenExpiresAt: Math.floor(Date.now() / 1000) + tokenData.expires_in,
      lastLoginAt: now, createdAt: now, updatedAt: now,
    });
  }

  // JWT token pair
  const { accessToken, refreshToken } = generateTokenPair(userId, userRole);
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(schema.refreshSessions).values({
    id: crypto.randomUUID(), userId, refreshToken, expiresAt,
  });

  // Auth code → Redis (フロントが exchange で取得)
  const authCode = crypto.randomUUID();
  await redis.set(`authcode:${authCode}`, JSON.stringify({
    accessToken, refreshToken, user: { id: userId, displayName: gUser.name, email: gUser.email, role: userRole },
  }), "EX", 300);

  if (aborted) return;
  redirect(res, `${frontend}?authCode=${authCode}`, [
    deleteCookieHeader(CSRF_COOKIE),
  ]);
}
