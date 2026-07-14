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
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { signIdToken } from "../auth/oidc-keys.js";
import { config } from "../config.js";
import { devLog } from "../logging/dev-logger.js";
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
  deleteAuthRequest,
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
  if (codeChallenge && codeChallengeMethod && codeChallengeMethod !== "S256") {
    return {
      kind: "redirect",
      url: appendQuery(redirectUri, {
        error: "invalid_request",
        error_description: "only S256 code_challenge_method is supported",
        state,
      }),
    };
  }

  const requestId = await putAuthRequest({
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
}

export async function getConsentInfo(requestId: string): Promise<ConsentInfo | null> {
  const req = await getAuthRequest(requestId);
  if (!req) return null;
  const client = await getClientByClientId(req.clientId);
  if (!client) return null;
  return { clientName: client.name, scopes: req.scope, redirectUri: req.redirectUri };
}

export async function approveAuthorization(requestId: string, userId: string): Promise<{ redirectTo: string }> {
  const req = await getAuthRequest(requestId);
  if (!req) throw AppError.badRequest("Invalid or expired authorization request");
  await deleteAuthRequest(requestId);

  const code = await putAuthCode({
    clientId: req.clientId,
    redirectUri: req.redirectUri,
    scope: req.scope,
    nonce: req.nonce,
    codeChallenge: req.codeChallenge,
    userId,
    authTime: Math.floor(Date.now() / 1000),
  });

  devLog("oidc.authorize.approved", { clientId: req.clientId, userId, requestId });
  return { redirectTo: appendQuery(req.redirectUri, { code, state: req.state }) };
}

export async function denyAuthorization(requestId: string): Promise<{ redirectTo: string }> {
  const req = await getAuthRequest(requestId);
  if (!req) throw AppError.badRequest("Invalid or expired authorization request");
  await deleteAuthRequest(requestId);
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

  if (record.clientId !== client.clientId) {
    throw new OidcError("invalid_grant", "code was issued to a different client");
  }
  if (!params.redirectUri || params.redirectUri !== record.redirectUri) {
    throw new OidcError("invalid_grant", "redirect_uri mismatch");
  }

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
  const idToken = signIdToken(
    {
      ...claims,
      iss: config.oidcIssuer,
      aud: client.clientId,
      auth_time: record.authTime,
      nonce: record.nonce,
    },
    ID_TOKEN_TTL_SEC,
  );

  const accessToken = await putAccessToken({
    userId: user.id,
    clientId: client.clientId,
    scope: record.scope,
  });

  await touchLastUsed(client.clientId);
  devLog("oidc.token.issued", { clientId: client.clientId, userId: user.id, scope: record.scope });

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SEC,
    id_token: idToken,
    scope: record.scope.join(" "),
  };
}

// ── userinfo ────────────────────────────────────────────────

export async function userinfo(accessToken: string | null): Promise<Record<string, unknown>> {
  if (!accessToken) throw AppError.unauthorized("missing access token");
  const record = await getAccessToken(accessToken);
  if (!record) throw AppError.unauthorized("invalid or expired access token");
  const user = await loadClaimUser(record.userId);
  if (!user) throw AppError.unauthorized("user no longer exists");
  return buildClaims(user, record.scope);
}

// ── discovery ───────────────────────────────────────────────

export { discoveryDocument };
