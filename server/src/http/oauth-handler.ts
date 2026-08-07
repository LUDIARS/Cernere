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
import { hashRefreshToken } from "../auth/token-hash.js";
import { redis, SESSION_TTL_SECS } from "../redis.js";
import { logAuthEvent } from "../logging/auth-logger.js";
import { encryptSecret } from "../lib/crypto/secret-box.js";
import { isCompositeTargetAllowed } from "../auth/composite-redirect.js";
import { verifyOAuthStateParam, isLinkStateToken } from "../auth/oauth-state.js";
import {
  createOAuthLinkGrant,
  deleteOAuthLinkGrant,
  loadOAuthLinkGrant,
  OAUTH_LINK_TTL_SEC,
  type OAuthLinkProvider,
} from "../auth/oauth-link.js";

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
  provider: "github" | "google" | "discord",
  action: "login" | "callback",
): void {
  // onAborted 必須
  let aborted = false;
  res.onAborted(() => { aborted = true; });

  const query = req.getQuery();
  const cookieHeader = req.getHeader("cookie") ?? "";
  const userAgent = req.getHeader("user-agent") ?? undefined;
  let ip: string | undefined;
  try {
    ip = Buffer.from(res.getRemoteAddressAsText()).toString() || undefined;
  } catch {
    ip = undefined;
  }
  const ctx = { ip, userAgent };

  // Composite origin (外部サービスからの認証委譲時に指定される)
  const queryParams = new URLSearchParams(query);
  const compositeOrigin = queryParams.get("composite_origin") ?? undefined;

  // 非同期処理
  (async () => {
    try {
      if (provider === "github" && action === "login") {
        await githubLogin(res, aborted, compositeOrigin);
      } else if (provider === "github" && action === "callback") {
        await githubCallback(res, query, cookieHeader, aborted, ctx);
      } else if (provider === "google" && action === "login") {
        await googleLogin(res, aborted, compositeOrigin);
      } else if (provider === "google" && action === "callback") {
        await googleCallback(res, query, cookieHeader, aborted, ctx);
      } else if (provider === "discord" && action === "callback") {
        await discordCallback(res, query, cookieHeader, aborted, ctx);
      } else {
        // Discord は link 専用 (サインアップ経路は持たない)。 未対応の組み合わせで
        // レスポンスを書かずに抜けると接続が宙吊りになるため、必ずエラーへ倒す。
        throw new Error("Unsupported OAuth route");
      }
    } catch (err) {
      const message = (err as Error).message;
      logAuthEvent({
        event: "user.oauth.failed",
        provider,
        error: message,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      if (aborted) return;
      redirect(res, `${config.frontendUrl}?authError=${encodeURIComponent(message)}`);
    }
  })();
}

/** Bearer-authenticated SPA initiation. The state cookie binds the returned URL to this browser. */
export async function prepareOAuthLinkForUser(
  provider: OAuthLinkProvider,
  userId: string,
): Promise<{ authorizationUrl: string; csrfCookie: string }> {
  const start = await createOAuthLinkGrant(provider, userId);
  return {
    authorizationUrl: start.authorizationUrl,
    csrfCookie: setCookieHeader(CSRF_COOKIE, start.state, OAUTH_LINK_TTL_SEC),
  };
}

/**
 * callback で link 対象 user を決める。 link ではない (通常ログイン) なら null。
 *
 * state 自体には権限も user id も入れない。Bearer + 必要なら action proof で作った
 * Redis grant だけが対象 user/provider を決め、HttpOnly state cookie が同じブラウザの
 * callback に束縛する。grant は対象を解決した時点で削除し、別 provider への持替えと
 * callback の再利用を許さない。
 */
async function resolveLinkTarget(
  stateParam: string,
  provider: OAuthLinkProvider,
): Promise<string | null> {
  const grant = await loadOAuthLinkGrant(stateParam, provider);
  if (!grant) return null;
  await deleteOAuthLinkGrant(stateParam);
  return grant.userId;
}

// ── Discord (link-only) ───────────────────────────────────

async function discordCallback(
  res: uWS.HttpResponse,
  query: string,
  cookieHeader: string,
  aborted: boolean,
  ctx: { ip?: string; userAgent?: string },
): Promise<void> {
  const params = new URLSearchParams(query);
  const code = params.get("code");
  const stateParam = params.get("state");
  const expectedState = getCookie(cookieHeader, CSRF_COOKIE);
  if (!stateParam || !expectedState || !verifyOAuthStateParam({ stateParam, cookieState: expectedState }).ok) {
    throw new Error("Invalid OAuth state");
  }
  if (!code) throw new Error("Authorization code not provided");
  const linkUserId = await resolveLinkTarget(stateParam, "discord");
  if (!linkUserId) {
    throw new Error(isLinkStateToken(stateParam)
      ? "Account link expired; please start linking again"
      : "Discord sign-in is not supported; start from account linking");
  }

  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.discordClientId,
      client_secret: config.discordClientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: config.discordRedirectUri,
    }),
  });
  if (!tokenRes.ok) throw new Error("Failed to exchange Discord authorization code");
  const token = await tokenRes.json() as { access_token?: unknown };
  if (typeof token.access_token !== "string" || token.access_token === "") {
    throw new Error("Discord did not return an access token");
  }
  const userRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${token.access_token}` },
    redirect: "error",
  });
  if (!userRes.ok) throw new Error("Failed to fetch Discord profile");
  const discordUser = await userRes.json() as {
    id?: unknown;
    username?: unknown;
    global_name?: unknown;
  };
  if (typeof discordUser.id !== "string" || discordUser.id === ""
    || typeof discordUser.username !== "string" || discordUser.username === "") {
    throw new Error("Discord returned an invalid user profile");
  }
  const discordDisplayName = typeof discordUser.global_name === "string"
    && discordUser.global_name.trim() !== ""
    ? discordUser.global_name.trim()
    : discordUser.username;

  const existing = await db.select({ id: schema.users.id }).from(schema.users)
    .where(eq(schema.users.discordId, discordUser.id)).limit(1);
  if (existing[0] && existing[0].id !== linkUserId) {
    // link は成立しないので付与済みの link 権限も即失効させる (TTL 任せにしない)。
    await deleteOAuthLinkGrant(stateParam);
    logAuthEvent({ event: "user.oauth.failed", userId: linkUserId, provider: "discord", linkAttempt: true, error: "discord account already linked to another user", ip: ctx.ip, userAgent: ctx.userAgent });
    if (!aborted) redirect(res, `${config.frontendUrl}?linkError=discord_already_linked`, [deleteCookieHeader(CSRF_COOKIE)]);
    return;
  }
  await db.update(schema.users).set({
    discordId: discordUser.id,
    discordUsername: discordDisplayName,
    updatedAt: new Date(),
  }).where(eq(schema.users.id, linkUserId));
  await deleteOAuthLinkGrant(stateParam);
  logAuthEvent({ event: "user.oauth", userId: linkUserId, provider: "discord", linked: true, ip: ctx.ip, userAgent: ctx.userAgent });
  if (aborted) return;
  redirect(res, `${config.frontendUrl}?linked=discord`, [deleteCookieHeader(CSRF_COOKIE)]);
}

// ── GitHub ─────────────────────────────────────────────────

async function githubLogin(res: uWS.HttpResponse, aborted: boolean, compositeOrigin?: string): Promise<void> {
  if (!config.githubClientId) throw new Error("GitHub OAuth is not configured");

  const csrfState = compositeOrigin
    ? `composite:${compositeOrigin}:${crypto.randomUUID()}`
    : crypto.randomUUID();
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

async function githubCallback(res: uWS.HttpResponse, query: string, cookieHeader: string, aborted: boolean, ctx: { ip?: string; userAgent?: string }): Promise<void> {
  const params = new URLSearchParams(query);
  const code = params.get("code");
  const stateParam = params.get("state");
  const expectedState = getCookie(cookieHeader, CSRF_COOKIE);
  const frontend = config.frontendUrl;

  const isComposite = stateParam?.startsWith("composite:");
  // 全フロー (通常 / composite / link) で cookie の state と厳密一致を要求する。
  // 旧実装は "link:" prefix で検証を丸ごとスキップし、攻撃者が state=link:<victim_uuid>
  // を送るだけで被害者の github_id を書き換えられた (Issue #63 C2)。
  // state 自体は権限を持たないため、link 対象の user_id/provider は state から読まず、
  // authenticated POST 時に Redis へ書いた `oauthlink:<state>` からのみ取得する。
  // 現在の "link:" prefix は権限を持たない目印にすぎず、 偽装しても link は成立しない
  // (Redis エントリが無ければエラーで終わる)。
  if (!stateParam || !expectedState || !verifyOAuthStateParam({ stateParam, cookieState: expectedState }).ok) {
    throw new Error("Invalid OAuth state");
  }
  if (!code) throw new Error("Authorization code not provided");
  const redisLinkUserId = await resolveLinkTarget(stateParam, "github");
  // link のつもりで始めた flow を通常ログインへ落とさない。 Redis の 600 秒を
  // 過ぎた callback をそのまま通すと、 「連携する」 を押しただけの利用者が
  // 別アカウントにサインイン (未登録なら新規作成) されてしまう。
  if (!redisLinkUserId && isLinkStateToken(stateParam)) {
    throw new Error("Account link expired; please start linking again");
  }

  // Exchange code for token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    redirect: "error",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code,
      redirect_uri: config.githubRedirectUri,
    }),
  });
  if (!tokenRes.ok) throw new Error("Failed to exchange GitHub authorization code");
  const tokenData = (await tokenRes.json()) as { access_token?: unknown };
  if (typeof tokenData.access_token !== "string" || tokenData.access_token === "") {
    throw new Error("GitHub did not return an access token");
  }

  // Fetch GitHub user
  const ghUserRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "Cernere" },
    redirect: "error",
  });
  if (!ghUserRes.ok) throw new Error("Failed to fetch GitHub profile");
  const rawGitHubUser = (await ghUserRes.json()) as {
    id?: unknown; login?: unknown; name?: unknown; avatar_url?: unknown; email?: unknown;
  };
  if (typeof rawGitHubUser.id !== "number" || !Number.isSafeInteger(rawGitHubUser.id)
    || typeof rawGitHubUser.login !== "string" || rawGitHubUser.login === ""
    || typeof rawGitHubUser.avatar_url !== "string"
    || (rawGitHubUser.name !== null && typeof rawGitHubUser.name !== "string")
    || (rawGitHubUser.email !== null && typeof rawGitHubUser.email !== "string")) {
    throw new Error("GitHub returned an invalid user profile");
  }
  const ghUser = {
    id: rawGitHubUser.id,
    login: rawGitHubUser.login,
    name: rawGitHubUser.name,
    avatar_url: rawGitHubUser.avatar_url,
    email: rawGitHubUser.email,
  };

  const now = new Date();

  // Account linking
  if (redisLinkUserId) {
    const linkUserId = redisLinkUserId;
    const existing = await db.select().from(schema.users)
      .where(eq(schema.users.githubId, ghUser.id)).limit(1);
    if (existing.length > 0 && existing[0].id !== linkUserId) {
      await deleteOAuthLinkGrant(stateParam);
      logAuthEvent({ event: "user.oauth.failed", userId: linkUserId, provider: "github", linkAttempt: true, error: "github account already linked to another user", ip: ctx.ip, userAgent: ctx.userAgent });
      if (aborted) return;
      redirect(res, `${frontend}?authError=${encodeURIComponent("This GitHub account is already linked to another user")}`, [
        deleteCookieHeader(CSRF_COOKIE),
      ]);
      return;
    }
    await db.update(schema.users).set({ githubId: ghUser.id, updatedAt: now })
      .where(eq(schema.users.id, linkUserId));
    await deleteOAuthLinkGrant(stateParam);
    logAuthEvent({ event: "user.oauth", userId: linkUserId, provider: "github", linked: true, ip: ctx.ip, userAgent: ctx.userAgent });
    if (aborted) return;
    redirect(res, `${frontend}?linked=github`, [deleteCookieHeader(CSRF_COOKIE)]);
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

  // Composite flow: auth_code を生成して composite callback にリダイレクト
  if (isComposite) {
    const userRole = userRows.length > 0 ? userRows[0].role : "general";
    const { accessToken, refreshToken } = generateTokenPair(userId, userRole);
    const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
    await db.insert(schema.refreshSessions).values({
      id: crypto.randomUUID(), userId, refreshToken: hashRefreshToken(refreshToken), expiresAt,
    });

    const authCode = crypto.randomUUID();
    await redis.set(`authcode:${authCode}`, JSON.stringify({
      accessToken, refreshToken,
      user: { id: userId, displayName: ghUser.name ?? ghUser.login, email: ghUser.email, role: userRole },
    }), "EX", 60);

    logAuthEvent({ event: "user.oauth", userId, email: ghUser.email ?? undefined, provider: "github", composite: true, ip: ctx.ip, userAgent: ctx.userAgent });

    // composite:<origin>:<uuid> から origin を抽出
    const compositeOrigin = stateParam!.split(":").slice(1, -1).join(":");
    if (aborted) return;
    // VULNWEB-001: 送信先 origin を許可リストで検証。 不正なら authCode を渡さず
    // エラーへ返す (Redis の authCode は未使用のまま TTL 失効させる)。
    if (!isCompositeTargetAllowed(compositeOrigin)) {
      logAuthEvent({ event: "user.oauth.failed", userId, provider: "github", composite: true, reason: "redirect target not allowlisted", ip: ctx.ip, userAgent: ctx.userAgent });
      redirect(res, `${config.frontendUrl}?authError=${encodeURIComponent("Invalid redirect target")}`, [
        deleteCookieHeader(CSRF_COOKIE),
      ]);
      return;
    }
    redirect(res, `${config.frontendUrl}/composite/callback?code=${authCode}&origin=${encodeURIComponent(compositeOrigin)}`, [
      deleteCookieHeader(CSRF_COOKIE),
    ]);
    return;
  }

  // Redis session
  const sessionId = crypto.randomUUID();
  await redis.set(`session:${sessionId}`, JSON.stringify({
    id: sessionId, userId, expiresAt: new Date(Date.now() + SESSION_TTL_SECS * 1000).toISOString(),
    accessToken: tokenData.access_token,
  }), "EX", SESSION_TTL_SECS);

  logAuthEvent({ event: "user.oauth", userId, email: ghUser.email ?? undefined, provider: "github", ip: ctx.ip, userAgent: ctx.userAgent });

  if (aborted) return;
  redirect(res, "/", [
    deleteCookieHeader(CSRF_COOKIE),
    setCookieHeader(SESSION_COOKIE, sessionId, SESSION_TTL_SECS),
  ]);
}

// ── Google ────────────────────────────────────────────────

async function googleLogin(res: uWS.HttpResponse, aborted: boolean, compositeOrigin?: string): Promise<void> {
  if (!config.googleClientId) throw new Error("Google OAuth is not configured");

  const csrfState = compositeOrigin
    ? `composite:${compositeOrigin}:${crypto.randomUUID()}`
    : crypto.randomUUID();
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

async function googleCallback(res: uWS.HttpResponse, query: string, cookieHeader: string, aborted: boolean, ctx: { ip?: string; userAgent?: string }): Promise<void> {
  const params = new URLSearchParams(query);
  const code = params.get("code");
  const stateParam = params.get("state");
  const expectedState = getCookie(cookieHeader, CSRF_COOKIE);
  const frontend = config.frontendUrl;

  const isCompositeGoogle = stateParam?.startsWith("composite:");
  if (!stateParam || !expectedState || !verifyOAuthStateParam({ stateParam, cookieState: expectedState }).ok) throw new Error("Invalid OAuth state");
  if (!code) throw new Error("Authorization code not provided");
  const linkUserId = await resolveLinkTarget(stateParam, "google");
  // github と同じく、 期限切れの link callback を通常ログインへ落とさない。
  if (!linkUserId && isLinkStateToken(stateParam)) {
    throw new Error("Account link expired; please start linking again");
  }

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    redirect: "error",
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
  const rawTokenData = (await tokenRes.json()) as {
    access_token?: unknown; refresh_token?: unknown; expires_in?: unknown;
  };
  if (typeof rawTokenData.access_token !== "string" || rawTokenData.access_token === ""
    || typeof rawTokenData.expires_in !== "number" || !Number.isFinite(rawTokenData.expires_in)
    || (rawTokenData.refresh_token !== undefined && typeof rawTokenData.refresh_token !== "string")) {
    throw new Error("Google returned an invalid token response");
  }
  const tokenData = {
    access_token: rawTokenData.access_token,
    refresh_token: rawTokenData.refresh_token,
    expires_in: rawTokenData.expires_in,
  };

  // Fetch Google user
  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
    redirect: "error",
  });
  if (!userRes.ok) throw new Error("Failed to fetch Google profile");
  const rawGoogleUser = (await userRes.json()) as {
    id?: unknown; email?: unknown; name?: unknown; picture?: unknown;
  };
  if (typeof rawGoogleUser.id !== "string" || rawGoogleUser.id === ""
    || typeof rawGoogleUser.email !== "string" || rawGoogleUser.email === ""
    || typeof rawGoogleUser.name !== "string" || rawGoogleUser.name === ""
    || typeof rawGoogleUser.picture !== "string") {
    throw new Error("Google returned an invalid user profile");
  }
  const gUser = {
    id: rawGoogleUser.id,
    email: rawGoogleUser.email,
    name: rawGoogleUser.name,
    picture: rawGoogleUser.picture,
  };

  const now = new Date();

  if (linkUserId) {
    const existing = await db.select({ id: schema.users.id }).from(schema.users)
      .where(eq(schema.users.googleId, gUser.id)).limit(1);
    if (existing[0] && existing[0].id !== linkUserId) {
      await deleteOAuthLinkGrant(stateParam);
      logAuthEvent({ event: "user.oauth.failed", userId: linkUserId, provider: "google", linkAttempt: true, error: "google account already linked to another user", ip: ctx.ip, userAgent: ctx.userAgent });
      if (!aborted) {
        redirect(res, `${frontend}?authError=${encodeURIComponent("This Google account is already linked to another user")}`, [
          deleteCookieHeader(CSRF_COOKIE),
        ]);
      }
      return;
    }
    await db.update(schema.users).set({ googleId: gUser.id, updatedAt: now }).where(eq(schema.users.id, linkUserId));
    await deleteOAuthLinkGrant(stateParam);
    // github / discord の link と同じく監査ログを残す (RULE.md Step 8)。
    logAuthEvent({ event: "user.oauth", userId: linkUserId, provider: "google", linked: true, ip: ctx.ip, userAgent: ctx.userAgent });
    if (!aborted) redirect(res, `${frontend}?linked=google`, [deleteCookieHeader(CSRF_COOKIE)]);
    return;
  }

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
      // 機密トークンは保存時に暗号化する (RULE.md §7.2)。refresh_token が
      // 今回返らない場合は既存 (暗号化済み) 値をそのまま保持する。
      googleAccessToken: encryptSecret(tokenData.access_token),
      googleRefreshToken: tokenData.refresh_token
        ? encryptSecret(tokenData.refresh_token)
        : userRows[0].googleRefreshToken,
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
      role: userRole, googleAccessToken: encryptSecret(tokenData.access_token),
      googleRefreshToken: tokenData.refresh_token ? encryptSecret(tokenData.refresh_token) : null,
      googleTokenExpiresAt: Math.floor(Date.now() / 1000) + tokenData.expires_in,
      lastLoginAt: now, createdAt: now, updatedAt: now,
    });
  }

  // JWT token pair
  const { accessToken, refreshToken } = generateTokenPair(userId, userRole);
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(schema.refreshSessions).values({
    id: crypto.randomUUID(), userId, refreshToken: hashRefreshToken(refreshToken), expiresAt,
  });

  // Auth code → Redis (フロントが exchange で取得)
  const authCode = crypto.randomUUID();
  const authCodeTtl = isCompositeGoogle ? 60 : 300;
  await redis.set(`authcode:${authCode}`, JSON.stringify({
    accessToken, refreshToken, user: { id: userId, displayName: gUser.name, email: gUser.email, role: userRole },
  }), "EX", authCodeTtl);

  logAuthEvent({ event: "user.oauth", userId, email: gUser.email, provider: "google", composite: isCompositeGoogle, ip: ctx.ip, userAgent: ctx.userAgent });

  if (aborted) return;

  // Composite flow: composite callback にリダイレクト
  if (isCompositeGoogle) {
    const compositeOrigin = stateParam!.split(":").slice(1, -1).join(":");
    // VULNWEB-001: 送信先 origin を許可リストで検証。 不正なら authCode を渡さない。
    if (!isCompositeTargetAllowed(compositeOrigin)) {
      logAuthEvent({ event: "user.oauth.failed", userId, provider: "google", composite: true, reason: "redirect target not allowlisted", ip: ctx.ip, userAgent: ctx.userAgent });
      redirect(res, `${frontend}?authError=${encodeURIComponent("Invalid redirect target")}`, [
        deleteCookieHeader(CSRF_COOKIE),
      ]);
      return;
    }
    redirect(res, `${frontend}/composite/callback?code=${authCode}&origin=${encodeURIComponent(compositeOrigin)}`, [
      deleteCookieHeader(CSRF_COOKIE),
    ]);
    return;
  }

  redirect(res, `${frontend}?authCode=${authCode}`, [
    deleteCookieHeader(CSRF_COOKIE),
  ]);
}
