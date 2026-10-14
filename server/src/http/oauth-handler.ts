/**
 * OAuth ハンドラ (uWebSockets.js 用)
 *
 * GitHub / Google / Discord の OAuth コールバックを処理する。アカウント連携専用で、
 * ログイン・新規作成には使わない (パスキーのみ。spec/plan/2026-10-14-passkey-only-authentication.md §1)。
 * Cookie は Set-Cookie ヘッダーで手動管理。
 */

import type uWS from "uWebSockets.js";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { config } from "../config.js";
import { logAuthEvent } from "../logging/auth-logger.js";
import { verifyOAuthStateParam, isLinkStateToken } from "../auth/oauth-state.js";
import { completeGoogleOidc } from "../auth/google-oidc-client.js";
import { AppError } from "../error.js";
import { LOGIN_METHOD_RETIRED_MESSAGE } from "../auth/retired-login.js";
import {
  createOAuthLinkGrant,
  deleteOAuthLinkGrant,
  loadOAuthLinkGrant,
  OAUTH_LINK_TTL_SEC,
  type OAuthLinkProvider,
} from "../auth/oauth-link.js";

const CSRF_COOKIE = "cernere_csrf_state";

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

  // 非同期処理
  (async () => {
    try {
      if (action === "login") {
        // GitHub / Google によるログイン・新規作成は廃止した (パスキーのみ)。
        // 連携は Bearer 認証済みの prepareOAuthLinkForUser から始める。
        throw new Error(LOGIN_METHOD_RETIRED_MESSAGE);
      } else if (provider === "github" && action === "callback") {
        await githubCallback(res, query, cookieHeader, aborted, ctx);
      } else if (provider === "google" && action === "callback") {
        await googleCallback(res, query, cookieHeader, () => aborted, ctx);
      } else if (provider === "discord" && action === "callback") {
        await discordCallback(res, query, cookieHeader, aborted, ctx);
      } else {
        // Discord は link 専用 (サインアップ経路は持たない)。 未対応の組み合わせで
        // レスポンスを書かずに抜けると接続が宙吊りになるため、必ずエラーへ倒す。
        throw new Error("Unsupported OAuth route");
      }
    } catch (err) {
      // Google failures can include database values or upstream responses; expose only known errors.
      const message = provider === "google" && !(err instanceof AppError)
        && (err as Error).message !== LOGIN_METHOD_RETIRED_MESSAGE
        ? "Google sign-in failed; please start again"
        : (err as Error).message;
      logAuthEvent({
        event: "user.oauth.failed",
        provider,
        error: message,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      if (aborted) return;
      const failureTarget = provider === "google"
        ? `${config.frontendUrl}/login/google/callback?error=${encodeURIComponent(message)}`
        : `${config.frontendUrl}?authError=${encodeURIComponent(message)}`;
      redirect(res, failureTarget, provider === "google" ? [deleteCookieHeader(CSRF_COOKIE)] : []);
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

async function githubCallback(res: uWS.HttpResponse, query: string, cookieHeader: string, aborted: boolean, ctx: { ip?: string; userAgent?: string }): Promise<void> {
  const params = new URLSearchParams(query);
  const code = params.get("code");
  const stateParam = params.get("state");
  const expectedState = getCookie(cookieHeader, CSRF_COOKIE);
  const frontend = config.frontendUrl;

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
  if (!redisLinkUserId) {
    throw new Error(isLinkStateToken(stateParam)
      ? "Account link expired; please start linking again"
      : LOGIN_METHOD_RETIRED_MESSAGE);
  }
  const linkUserId = redisLinkUserId;

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

  // Account linking (ログインには使わない)
  {
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

}

// ── Google ────────────────────────────────────────────────

/** @implements SPEC-GOOGLE-OIDC-VERIFICATION */
async function googleCallback(res: uWS.HttpResponse, query: string, cookieHeader: string, isAborted: () => boolean, ctx: { ip?: string; userAgent?: string }): Promise<void> {
  const params = new URLSearchParams(query);
  const code = params.get("code");
  const stateParam = params.get("state");
  const expectedState = getCookie(cookieHeader, CSRF_COOKIE);
  const frontend = config.frontendUrl;

  if (!stateParam || !expectedState || !verifyOAuthStateParam({ stateParam, cookieState: expectedState }).ok) throw new Error("Invalid OAuth state");
  if (!code) throw new Error("Authorization code not provided");
  const verified = await completeGoogleOidc(stateParam, code);
  const linkUserId = await resolveLinkTarget(stateParam, "google");
  // github と同じく、 期限切れの link callback を通常ログインへ落とさない。
  if (!linkUserId) {
    throw new Error(isLinkStateToken(stateParam)
      ? "Account link expired; please start linking again"
      : LOGIN_METHOD_RETIRED_MESSAGE);
  }

  const gUser = {
    id: verified.identity.sub,
    email: verified.identity.email,
    name: verified.identity.name ?? verified.identity.email.split("@")[0],
    picture: verified.identity.picture,
  };

  const now = new Date();

  {
    const existing = await db.select({ id: schema.users.id }).from(schema.users)
      .where(eq(schema.users.googleId, gUser.id)).limit(1);
    if (existing[0] && existing[0].id !== linkUserId) {
      await deleteOAuthLinkGrant(stateParam);
      logAuthEvent({ event: "user.oauth.failed", userId: linkUserId, provider: "google", linkAttempt: true, error: "google account already linked to another user", ip: ctx.ip, userAgent: ctx.userAgent });
      if (!isAborted()) {
        redirect(res, `${frontend}?authError=${encodeURIComponent("This Google account is already linked to another user")}`, [
          deleteCookieHeader(CSRF_COOKIE),
        ]);
      }
      return;
    }
    // email は Google の ID トークン検証で email_verified=true を確認済み (google-id-token.ts)。
    await db.update(schema.users).set({ googleId: gUser.id, googleVerifiedEmail: gUser.email, updatedAt: now }).where(eq(schema.users.id, linkUserId));
    await deleteOAuthLinkGrant(stateParam);
    // github / discord の link と同じく監査ログを残す (RULE.md Step 8)。
    logAuthEvent({ event: "user.oauth", userId: linkUserId, provider: "google", linked: true, ip: ctx.ip, userAgent: ctx.userAgent });
    if (!isAborted()) redirect(res, `${frontend}?linked=google`, [deleteCookieHeader(CSRF_COOKIE)]);
    return;
  }
}
