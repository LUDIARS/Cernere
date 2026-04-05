/**
 * Google OAuth フロー
 */

import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { config } from "../config.js";
import { AppError } from "../error.js";
import { generateTokenPair, REFRESH_TOKEN_DAYS } from "./jwt.js";
import { redis } from "../redis.js";

const CSRF_COOKIE = "cernere_csrf_state";

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

interface GoogleUserInfo {
  id: string;
  email: string;
  name: string;
  picture?: string;
}

export const googleOAuthRoutes = new Hono();

// ── GET /auth/google/login ───────────────────────────────────

googleOAuthRoutes.get("/google/login", async (c) => {
  if (!config.googleClientId) {
    throw AppError.badRequest("Google OAuth is not configured");
  }

  const csrfState = crypto.randomUUID();
  setCookie(c, CSRF_COOKIE, csrfState, {
    path: "/",
    httpOnly: true,
    maxAge: 600,
    sameSite: "Lax",
    secure: config.isHttps,
  });

  const scopes = "openid email profile";
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.googleRedirectUri,
    response_type: "code",
    scope: scopes,
    access_type: "offline",
    prompt: "consent",
    state: csrfState,
  });

  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// ── GET /auth/google/callback ────────────────────────────────

googleOAuthRoutes.get("/google/callback", async (c) => {
  const frontend = config.frontendUrl;
  const error = c.req.query("error");
  const stateParam = c.req.query("state");
  const code = c.req.query("code");

  deleteCookie(c, CSRF_COOKIE, { path: "/" });

  if (error) {
    return c.redirect(`${frontend}?authError=${encodeURIComponent(error)}`);
  }

  // CSRF 検証 (link: プレフィックスは除外)
  if (stateParam && !stateParam.startsWith("link:")) {
    const expected = getCookie(c, CSRF_COOKIE);
    if (expected !== stateParam) {
      throw AppError.badRequest("Invalid OAuth state");
    }
  }

  if (!code) {
    throw AppError.badRequest("Authorization code not provided");
  }

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: config.googleRedirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    return c.redirect(`${frontend}?authError=${encodeURIComponent("Failed to exchange authorization code")}`);
  }

  const tokenData: GoogleTokenResponse = await tokenRes.json();

  // Fetch user info
  const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const userInfo: GoogleUserInfo = await userInfoRes.json();

  const now = new Date();
  const tokenExpiresAt = Date.now() + tokenData.expires_in * 1000;
  const scopes = tokenData.scope?.split(" ") ?? [];

  // Account linking (link: prefix)
  if (stateParam?.startsWith("link:")) {
    const parts = stateParam.split(":");
    if (parts.length >= 2) {
      const linkUserId = parts[1];
      const existing = await db.select().from(schema.users)
        .where(eq(schema.users.googleId, userInfo.id)).limit(1);
      if (existing.length > 0 && existing[0].id !== linkUserId) {
        return c.redirect(`${frontend}?authError=${encodeURIComponent("This Google account is already linked to another user")}`);
      }

      await db.update(schema.users).set({
        googleId: userInfo.id,
        googleAccessToken: tokenData.access_token,
        googleRefreshToken: tokenData.refresh_token ?? undefined,
        googleTokenExpiresAt: tokenExpiresAt,
        googleScopes: scopes,
        updatedAt: now,
      }).where(eq(schema.users.id, linkUserId));

      return c.redirect(`${frontend}?linked=google`);
    }
  }

  // Find or create user
  let userRows = await db.select().from(schema.users)
    .where(eq(schema.users.googleId, userInfo.id)).limit(1);
  if (userRows.length === 0) {
    userRows = await db.select().from(schema.users)
      .where(eq(schema.users.email, userInfo.email)).limit(1);
  }

  let userId: string;
  let userRole: string;

  if (userRows.length > 0) {
    const existing = userRows[0];
    userId = existing.id;
    userRole = existing.role;
    await db.update(schema.users).set({
      googleId: userInfo.id,
      googleAccessToken: tokenData.access_token,
      googleRefreshToken: tokenData.refresh_token ?? existing.googleRefreshToken ?? undefined,
      googleTokenExpiresAt: tokenExpiresAt,
      googleScopes: scopes,
      displayName: userInfo.name,
      avatarUrl: userInfo.picture ?? "",
      lastLoginAt: now,
      updatedAt: now,
    }).where(eq(schema.users.id, existing.id));
  } else {
    const countResult = await db.select({ count: sql<number>`count(*)` }).from(schema.users);
    const role = Number(countResult[0]?.count ?? 0) === 0 ? "admin" : "general";
    userId = crypto.randomUUID();
    userRole = role;

    await db.insert(schema.users).values({
      id: userId,
      login: userInfo.email,
      displayName: userInfo.name,
      avatarUrl: userInfo.picture ?? "",
      email: userInfo.email,
      role,
      googleId: userInfo.id,
      googleAccessToken: tokenData.access_token,
      googleRefreshToken: tokenData.refresh_token,
      googleTokenExpiresAt: tokenExpiresAt,
      googleScopes: scopes,
      lastLoginAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Generate JWT tokens
  const { accessToken, refreshToken } = generateTokenPair(userId, userRole);
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(schema.refreshSessions).values({
    id: crypto.randomUUID(),
    userId,
    refreshToken,
    expiresAt,
  });

  // Store auth code in Redis for frontend exchange
  const authCode = crypto.randomUUID();
  await redis.set(`authcode:${authCode}`, JSON.stringify({ accessToken, refreshToken }), "EX", 300);

  return c.redirect(`${frontend}?authCode=${encodeURIComponent(authCode)}`);
});
