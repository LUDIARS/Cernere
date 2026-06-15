/**
 * OIDC スコープ → claims マッピング、 PKCE 検証、 discovery ドキュメント
 *
 * 純粋関数のみ。 DB / Redis に依存しないのでユニットテストしやすい。
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

export const SUPPORTED_SCOPES = ["openid", "email", "profile"] as const;
export const SUPPORTED_RESPONSE_TYPES = ["code"] as const;
export const ID_TOKEN_TTL_SEC = 3600;
export const ACCESS_TOKEN_TTL_SEC = 3600;
/** authorization code の寿命。 RFC 6749 は 10 分以内推奨。 RP は即時交換する想定なので短め。 */
export const AUTH_CODE_TTL_SEC = 120;
/** consent 待ち (authorize → approve) の寿命。 */
export const AUTH_REQUEST_TTL_SEC = 600;

/** id_token / userinfo に載せる元ユーザー情報。 */
export interface ClaimSourceUser {
  id: string;
  email: string | null;
  displayName: string | null;
  login: string | null;
  avatarUrl: string | null;
  hasVerifiedIdentity: boolean; // google / github 連携済みなら true
}

/** scope に応じて claims を組み立てる。 sub は常に含む。 */
export function buildClaims(user: ClaimSourceUser, scope: string[]): Record<string, unknown> {
  const claims: Record<string, unknown> = { sub: user.id };

  if (scope.includes("email") && user.email) {
    claims.email = user.email;
    claims.email_verified = user.hasVerifiedIdentity;
  }

  if (scope.includes("profile")) {
    if (user.displayName) claims.name = user.displayName;
    if (user.login) claims.preferred_username = user.login;
    if (user.avatarUrl) claims.picture = user.avatarUrl;
  }

  return claims;
}

/** スコープ文字列 (space 区切り) を配列に。 サポート外は捨てる。 openid は必須。 */
export function parseScope(raw: string | undefined): string[] {
  const requested = (raw ?? "").split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const allowed = requested.filter((s) => (SUPPORTED_SCOPES as readonly string[]).includes(s));
  return allowed;
}

/** RP が要求したスコープを、 client 登録スコープと交差させる。 */
export function intersectScopes(requested: string[], clientScopes: string[]): string[] {
  return requested.filter((s) => clientScopes.includes(s));
}

/**
 * PKCE (RFC 7636) S256 検証。 plain は弱いので非対応。
 * code_challenge === BASE64URL(SHA256(code_verifier)) を定数時間比較する。
 */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash("sha256").update(codeVerifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** `/.well-known/openid-configuration` のボディ。 issuer 基準で endpoint を組む。 */
export function discoveryDocument(): Record<string, unknown> {
  const issuer = config.oidcIssuer;
  return {
    issuer,
    authorization_endpoint: `${issuer}/oidc/authorize`,
    token_endpoint: `${issuer}/oidc/token`,
    userinfo_endpoint: `${issuer}/oidc/userinfo`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: [...SUPPORTED_RESPONSE_TYPES],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: [...SUPPORTED_SCOPES],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    claims_supported: [
      "sub", "iss", "aud", "exp", "iat", "nonce",
      "email", "email_verified", "name", "preferred_username", "picture",
    ],
  };
}
