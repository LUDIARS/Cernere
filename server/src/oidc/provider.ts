/**
 * OIDC Provider コアロジック
 *
 * authorize → consent → code → token → userinfo の各ステップを束ねる。
 * HTTP 非依存 (http/oidc-handler.ts から呼ばれる純粋なサービス層)。
 *
 * フロー (認可コード + PKCE、 consent はフロント仲介):
 *   1. RP → GET /oidc/authorize         createAuthorization() で検証 → consent 画面へ
 *   2. フロント → POST /api/auth/oidc/approve  approve() が code 発行 → RP へ redirect
 *   3. RP → POST /oidc/token            exchangeToken() が id_token + access_token 発行
 *   4. RP → GET /oidc/userinfo          userinfo() が claims 返却
 */

import { eq } from "drizzle-orm";
import type { JwtClaims } from "../auth/jwt.js";
import { checkOidcAuthentication, enterpriseOidcClaims } from "../enterprise/oidc-policy.js";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { signIdToken } from "../auth/oidc-keys.js";
import { config } from "../config.js";
import { devLog } from "../logging/dev-logger.js";
import { assertUserSessionCurrent, currentUserSessionState, type UserSessionState } from "../auth/user-session-state.js";
import { readAuthenticationEvidence } from "../lib/authentication-evidence.js";
import {
  getClientByClientId,
  isRedirectUriAllowed,
  touchLastUsed,
  verifyClientSecret,
  type OidcClientRecord,
} from "./clients.js";
import {
  ACCESS_TOKEN_TTL_SEC,
  ID_TOKEN_TTL_SEC,
  buildClaims,
  discoveryDocument,
  intersectScopes,
  parseScope,
  verifyPkceS256,
  type ClaimSourceUser,
} from "./scopes.js";
import {
  consumeAuthCode,
  consumeAuthRequest,
  getAccessToken,
  getAuthRequest,
  putAccessToken,
  putAuthCode,
  putAuthRequest,
} from "./store.js";

/** token / userinfo エンドポイントが返す OAuth 形式エラー。 */
export class OidcError extends Error {
  constructor(
    public readonly error: string,
    public readonly description: string,
    public readonly httpStatus = 400,
  ) {
    super(description);
    this.name = "OidcError";
  }
}

// ── 共通ヘルパー ────────────────────────────────────────────

function appendQuery(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  return url.toString();
}

async function loadClaimUser(userId: string): Promise<ClaimSourceUser | null> {
  const rows = await db.select().from(schema.users)
    .where(eq(schema.users.id, userId)).limit(1);
  if (rows.length === 0) return null;
  const u = rows[0];
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    login: u.login,
    avatarUrl: u.avatarUrl,
    hasVerifiedIdentity: !!u.googleId || u.githubId != null,
  };
}

// ── authorize ───────────────────────────────────────────────

export type AuthorizeOutcome =
  | { kind: "consent"; requestId: string }
  | { kind: "redirect"; url: string };

/**
 * authorize リクエストを検証し、 consent 画面へ進めるか error redirect を返す。
 *
 * client_id / redirect_uri が不正なときは「安全に redirect できない」ため
 * AppError を throw する (呼び出し側はエラーページを表示)。 それ以降の検証
 * エラーは redirect_uri に error= を付けて返す (RFC 6749 §4.1.2.1)。
 */
export async function createAuthorization(q: URLSearchParams): Promise<AuthorizeOutcome> {
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";

  if (!clientId) throw AppError.badRequest("client_id is required");
  const client = await getClientByClientId(clientId);
  if (!client || !client.isActive) throw AppError.badRequest("Unknown or inactive client_id");

  if (!redirectUri) throw AppError.badRequest("redirect_uri is required");
  if (!isRedirectUriAllowed(client, redirectUri)) {
    throw AppError.badRequest("redirect_uri does not match any registered URI");
  }

  // ここから先のエラーは redirect_uri に返す。
  const state = q.get("state") ?? undefined;
  const responseType = q.get("response_type") ?? "";
  if (responseType !== "code") {
    return {
      kind: "redirect",
      url: appendQuery(redirectUri, {
        error: "unsupported_response_type",
        error_description: "only response_type=code is supported",
        state,
      }),
    };
  }

  const requested = parseScope(q.get("scope") ?? undefined);
  if (!requested.includes("openid")) {
    return {
      kind: "redirect",
      url: appendQuery(redirectUri, {
        error: "invalid_scope",
        error_description: "the 'openid' scope is required",
        state,
      }),
    };
  }
  const scope = intersectScopes(requested, client.scopes);

  const codeChallenge = q.get("code_challenge") ?? undefined;
  const codeChallengeMethod = q.get("code_challenge_method") ?? undefined;
  if ((codeChallenge && (codeChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge))) || (!codeChallenge && codeChallengeMethod)) {
    return {
      kind: "redirect",
      url: appendQuery(redirectUri, {
        error: "invalid_request",
        error_description: "only S256 code_challenge_method is supported",
        state,
      }),
    };
  }

  const prompts = (q.get("prompt") ?? "").split(" ").filter(Boolean);
  const maxAgeRaw = q.get("max_age");
  if (prompts.some((p) => !["none", "login", "consent", "select_account"].includes(p))
    || (prompts.includes("none") && prompts.length > 1)
    || (maxAgeRaw !== null && (!/^\d+$/.test(maxAgeRaw) || !Number.isSafeInteger(Number(maxAgeRaw))))) {
    return { kind: "redirect", url: appendQuery(redirectUri, { error: "invalid_request", state }) };
  }
  // No silent-consent store exists; prompt=none must never open interactive UI.
  if (prompts.includes("none")) return { kind: "redirect", url: appendQuery(redirectUri, { error: "interaction_required", state }) };
  const requestId = await putAuthRequest({
    createdAtMs: Date.now(),
    forceReauth: prompts.includes("login") || prompts.includes("select_account") || (maxAgeRaw !== null && Number(maxAgeRaw) === 0),
    maxAge: maxAgeRaw === null ? undefined : Number(maxAgeRaw),
    clientId,
    redirectUri,
    scope,
    state,
    nonce: q.get("nonce") ?? undefined,
    codeChallenge,
    codeChallengeMethod,
  });

  devLog("oidc.authorize.created", { clientId, requestId, scope });
  return { kind: "consent", requestId };
}

// ── consent ─────────────────────────────────────────────────

export interface ConsentInfo {
  clientName: string;
  scopes: string[];
  redirectUri: string;
  reauthenticationRequired: boolean;
  authenticationMessage?: string;
}

export async function getConsentInfo(requestId: string, claims?: JwtClaims): Promise<ConsentInfo | null> {
  const req = await getAuthRequest(requestId);
  if (!req) return null;
  const client = await getClientByClientId(req.clientId);
  if (!client?.isActive || !isRedirectUriAllowed(client, req.redirectUri)) return null;
  let authenticationMessage: string | undefined;
  if (claims) {
    try { await checkOidcAuthentication(req.clientId, claims.sub, claims.authentication, req); }
    catch (error) {
      if (!(error instanceof AppError) || error.statusCode !== 401) throw error;
      authenticationMessage = error.message;
    }
  }
  return { clientName: client.name, scopes: req.scope, redirectUri: req.redirectUri,
    reauthenticationRequired: !claims || !!authenticationMessage, authenticationMessage };
}

/** 承認は main の provenance 検査 (authEpoch/デバイス失効) と、 企業接続ポリシーの両方を通す。
 *  source には検証済み JwtClaims をそのまま渡す (exp を見てログインセッション切れも弾く)。 */
export async function approveAuthorization(requestId: string, userId: string, authentication?: unknown,
  source?: UserSessionState & { exp?: number }): Promise<{ redirectTo: string }> {
  if (source?.exp !== undefined && source.exp * 1000 <= Date.now()) throw AppError.unauthorized("Login session expired");
  const authorization = source ?? { ...await currentUserSessionState(userId), authentication: readAuthenticationEvidence(authentication) };
  if (authorization.sub !== userId) throw AppError.unauthorized("OIDC session user mismatch");
  await assertUserSessionCurrent(authorization);
  const req = await getAuthRequest(requestId);
  if (!req) throw AppError.badRequest("Invalid or expired authorization request");
  const client = await getClientByClientId(req.clientId);
  if (!client?.isActive || !isRedirectUriAllowed(client, req.redirectUri)) throw AppError.forbidden("OIDC client changed");
  const facts = await checkOidcAuthentication(req.clientId, userId, authorization.authentication, req);
  if (!await consumeAuthRequest(requestId)) throw AppError.badRequest("Authorization request already used");

  const code = await putAuthCode({
    clientId: req.clientId,
    redirectUri: req.redirectUri,
    scope: req.scope,
    nonce: req.nonce,
    codeChallenge: req.codeChallenge,
    userId,
    authorization,
    enterprise: facts.enterprise,
  });

  devLog("oidc.authorize.approved", { clientId: req.clientId, userId, requestId });
  return { redirectTo: appendQuery(req.redirectUri, { code, state: req.state }) };
}

export async function denyAuthorization(requestId: string): Promise<{ redirectTo: string }> {
  const req = await consumeAuthRequest(requestId);
  if (!req) throw AppError.badRequest("Invalid or expired authorization request");
  return {
    redirectTo: appendQuery(req.redirectUri, {
      error: "access_denied",
      error_description: "the user denied the authorization request",
      state: req.state,
    }),
  };
}

// ── token ───────────────────────────────────────────────────

export interface TokenRequestParams {
  grantType?: string;
  code?: string;
  redirectUri?: string;
  clientId?: string;
  clientSecret?: string;
  codeVerifier?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  id_token: string;
  scope: string;
}

/** client を認証する。 client_secret_basic / post の両方を受ける。 */
async function authenticateClient(params: TokenRequestParams): Promise<OidcClientRecord> {
  const { clientId, clientSecret } = params;
  if (!clientId) throw new OidcError("invalid_client", "client_id is required", 401);
  const client = await getClientByClientId(clientId);
  if (!client || !client.isActive) {
    throw new OidcError("invalid_client", "unknown or inactive client", 401);
  }
  if (!clientSecret) throw new OidcError("invalid_client", "client_secret is required", 401);
  const ok = await verifyClientSecret(client, clientSecret);
  if (!ok) throw new OidcError("invalid_client", "invalid client credentials", 401);
  return client;
}

export async function exchangeToken(params: TokenRequestParams): Promise<TokenResponse> {
  if (params.grantType !== "authorization_code") {
    throw new OidcError("unsupported_grant_type", "only authorization_code is supported");
  }
  if (!params.code) throw new OidcError("invalid_request", "code is required");

  const client = await authenticateClient(params);

  const record = await consumeAuthCode(params.code);
  if (!record) throw new OidcError("invalid_grant", "code is invalid, expired, or already used");
  if (!record.authorization || record.authorization.sub !== record.userId) throw new OidcError("invalid_grant", "Session provenance is unavailable");
  try { await assertUserSessionCurrent(record.authorization); }
  catch { throw new OidcError("invalid_grant", "Authorizing session was revoked"); }

  if (record.clientId !== client.clientId) {
    throw new OidcError("invalid_grant", "code was issued to a different client");
  }
  if (!params.redirectUri || params.redirectUri !== record.redirectUri) {
    throw new OidcError("invalid_grant", "redirect_uri mismatch");
  }
  if (!isRedirectUriAllowed(client, record.redirectUri)) throw new OidcError("invalid_grant", "client redirect changed");
  try { await checkOidcAuthentication(client.clientId, record.userId, record.authorization.authentication, undefined, record.enterprise); }
  catch { throw new OidcError("invalid_grant", "authentication expired or authorization changed"); }

  // PKCE: code_challenge があれば code_verifier 必須。
  if (record.codeChallenge) {
    if (!params.codeVerifier) throw new OidcError("invalid_grant", "code_verifier is required");
    if (!verifyPkceS256(params.codeVerifier, record.codeChallenge)) {
      throw new OidcError("invalid_grant", "PKCE verification failed");
    }
  }

  const user = await loadClaimUser(record.userId);
  if (!user) throw new OidcError("invalid_grant", "user no longer exists");

  const claims = buildClaims(user, record.scope);
  const authenticated = record.authorization.authentication;
  const ttl = Math.min(ACCESS_TOKEN_TTL_SEC, ID_TOKEN_TTL_SEC,
    record.enterprise ? record.enterprise.expiresAt - Math.floor(Date.now() / 1000) : ACCESS_TOKEN_TTL_SEC);
  if (ttl <= 0) throw new OidcError("invalid_grant", "authentication expired");
  const idToken = signIdToken(
    {
      ...claims,
      iss: config.oidcIssuer,
      aud: client.clientId,
      ...(authenticated ? { auth_time: authenticated.authTime, amr: authenticated.amr,
        cr_auth_revision: authenticated.revision } : {}),
      ...enterpriseOidcClaims(record.enterprise),
      ...(record.enterprise ? { cr_user_id: user.id } : {}),
      nonce: record.nonce,
    },
    ttl,
  );

  const accessToken = await putAccessToken({
    authorization: record.authorization,
    userId: user.id,
    clientId: client.clientId,
    scope: record.scope,
    enterprise: record.enterprise,
  }, ttl);

  await touchLastUsed(client.clientId);
  devLog("oidc.token.issued", { clientId: client.clientId, userId: user.id, scope: record.scope });

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ttl,
    id_token: idToken,
    scope: record.scope.join(" "),
  };
}

// ── userinfo ────────────────────────────────────────────────

export async function userinfo(accessToken: string | null): Promise<Record<string, unknown>> {
  if (!accessToken) throw AppError.unauthorized("missing access token");
  const record = await getAccessToken(accessToken);
  if (!record) throw AppError.unauthorized("invalid or expired access token");
  if (!record.authorization || record.authorization.sub !== record.userId) throw AppError.unauthorized("Session provenance is unavailable");
  await assertUserSessionCurrent(record.authorization);
  const client = await getClientByClientId(record.clientId);
  if (!client?.isActive) throw AppError.unauthorized("OIDC client is disabled");
  await checkOidcAuthentication(record.clientId, record.userId, record.authorization.authentication, undefined, record.enterprise);
  const user = await loadClaimUser(record.userId);
  if (!user) throw AppError.unauthorized("user no longer exists");
  return { ...buildClaims(user, record.scope), ...enterpriseOidcClaims(record.enterprise),
    ...(record.enterprise ? { cr_user_id: user.id } : {}),
    ...(record.authorization.authentication ? { auth_time: record.authorization.authentication.authTime,
      amr: record.authorization.authentication.amr, cr_auth_revision: record.authorization.authentication.revision } : {}) };
}

// ── discovery ───────────────────────────────────────────────

export { discoveryDocument };
