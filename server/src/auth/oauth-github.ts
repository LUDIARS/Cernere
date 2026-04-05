/**
 * GitHub OAuth フロー
 */

import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { config } from "../config.js";
import { AppError } from "../error.js";
import { generateTokenPair, REFRESH_TOKEN_DAYS } from "./jwt.js";
import { redis, SESSION_TTL_SECS } from "../redis.js";

const CSRF_COOKIE = "cernere_csrf_state";
const SESSION_COOKIE = "ars_session";

interface GitHubTokenResponse {
  access_token: string;
}

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  email: string | null;
}

export const githubOAuthRoutes = new Hono();

// ── GET /auth/github/login ───────────────────────────────────

githubOAuthRoutes.get("/github/login", async (c) => {
  if (!config.githubClientId) {
    throw AppError.badRequest("GitHub OAuth is not configured");
  }

  const csrfState = crypto.randomUUID();
  setCookie(c, CSRF_COOKIE, csrfState, {
    path: "/",
    httpOnly: true,
    maxAge: 600,
    sameSite: "Lax",
    secure: config.isHttps,
  });

  const params = new URLSearchParams({
    client_id: config.githubClientId,
    redirect_uri: config.githubRedirectUri,
    scope: "read:user user:email repo",
    state: csrfState,
  });

  return c.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// ── GET /auth/github/callback ────────────────────────────────

githubOAuthRoutes.get("/github/callback", async (c) => {
  const frontend = config.frontendUrl;
  const code = c.req.query("code");
  const stateParam = c.req.query("state");
  const expectedState = getCookie(c, CSRF_COOKIE);

  deleteCookie(c, CSRF_COOKIE, { path: "/" });

  if (!stateParam || (!stateParam.startsWith("link:") && expectedState !== stateParam)) {
    throw AppError.badRequest("Invalid OAuth state");
  }
  if (!code) {
    throw AppError.badRequest("Authorization code not provided");
  }

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
  const tokenData: GitHubTokenResponse = await tokenRes.json();

  // Fetch GitHub user
  const ghUserRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "User-Agent": "Cernere",
    },
  });
  const ghUser: GitHubUser = await ghUserRes.json();

  const now = new Date();

  // Account linking
  if (stateParam.startsWith("link:")) {
    const parts = stateParam.split(":");
    if (parts.length >= 2) {
      const linkUserId = parts[1];
      const existing = await db.select().from(schema.users)
        .where(eq(schema.users.githubId, ghUser.id)).limit(1);
      if (existing.length > 0 && existing[0].id !== linkUserId) {
        return c.redirect(`${frontend}?authError=${encodeURIComponent("This GitHub account is already linked to another user")}`);
      }

      await db.update(schema.users).set({
        githubId: ghUser.id,
        updatedAt: now,
      }).where(eq(schema.users.id, linkUserId));

      return c.redirect(`${frontend}?linked=github`);
    }
  }

  // Find or create user
  let userId: string;
  let userRole: string;

  const userRows = await db.select().from(schema.users)
    .where(eq(schema.users.githubId, ghUser.id)).limit(1);

  if (userRows.length > 0) {
    const existing = userRows[0];
    userId = existing.id;
    userRole = existing.role;
    await db.update(schema.users).set({
      login: ghUser.login,
      displayName: ghUser.name ?? ghUser.login,
      avatarUrl: ghUser.avatar_url,
      email: ghUser.email,
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
      githubId: ghUser.id,
      login: ghUser.login,
      displayName: ghUser.name ?? ghUser.login,
      avatarUrl: ghUser.avatar_url,
      email: ghUser.email,
      role,
      lastLoginAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Create Redis session (Cookie-based for Ars BFF)
  const sessionId = crypto.randomUUID();
  await redis.set(`session:${sessionId}`, JSON.stringify({
    id: sessionId,
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_SECS * 1000).toISOString(),
    accessToken: tokenData.access_token,
  }), "EX", SESSION_TTL_SECS);

  setCookie(c, SESSION_COOKIE, sessionId, {
    path: "/",
    httpOnly: true,
    maxAge: SESSION_TTL_SECS,
    sameSite: "Lax",
    secure: config.isHttps,
  });

  return c.redirect("/");
});
