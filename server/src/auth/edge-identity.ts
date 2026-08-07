/**
 * Cloudflare Access の identity 取得 (`/cdn-cgi/access/get-identity`)
 *
 * spec/feature/edge-assertion-login.md §5.3。
 *
 * アサーションの標準 claim には氏名もグループも入らないため、 検証成功後に
 * CF へ問い合わせて `user_uuid` / `name` / `groups` を取る。 これは既定動作で、
 * binding の `fetch_identity = false` のときだけ省略する。
 *
 * **呼ぶのは Cernere 自身**。 呼び出し元 (Hub) が取得した JSON を受け取る形には
 * しない — groups は認可に効くので、 署名の無い値を経路に挟まない。 Hub からは
 * `CF_Authorization` クッキーの値だけを受け取り、 問い合わせはここで行う。
 *
 * キャッシュキーはアサーションの `identity_nonce`。 CF 自身が
 * "a cache key used to get the user's identity" と定義している claim なので、
 * そのまま使う。
 */

import { redis } from "../redis.js";
import type { FetchLike } from "./edge-jwks.js";

const IDENTITY_CACHE_TTL_SEC = 600;

export interface EdgeIdentityGroup {
  id: string;
  name: string;
}

export interface EdgeIdentity {
  email: string | null;
  name: string | null;
  userUuid: string | null;
  idpType: string | null;
  groups: EdgeIdentityGroup[];
  amr: string[];
}

interface RawIdentity {
  email?: unknown;
  name?: unknown;
  user_uuid?: unknown;
  idp?: { type?: unknown } | null;
  groups?: unknown;
  amr?: unknown;
}

/** nonce は CF が発行するが、 team を跨いで衝突させないよう team domain で分ける。 */
function identityCacheKey(teamDomain: string, nonce: string): string {
  return `edge:identity:${teamDomain}:${nonce}`;
}

/**
 * cookie 値として安全な文字だけか見る (RFC 6265 cookie-octet 相当)。
 *
 * `cfAuthorization` は Hub から渡された未検証の文字列で、 そのまま `cookie`
 * ヘッダに埋める。 `;` や制御文字を通すと別クッキーを差し込まれる余地が残るので、
 * 形が違えば問い合わせ自体を行わない (fail-closed)。
 */
function isSafeCookieValue(value: string): boolean {
  return /^[!#-+\--:<-\[\]-~]+$/.test(value);
}

/**
 * identity を取得する。 取得できなければ null を返す (呼び出し側は認証を継続し、
 * groups を空として扱う)。
 *
 * @param identityNonce アサーションの `identity_nonce`。 キャッシュキーに使う。
 * @param cfAuthorization Hub が転送した `CF_Authorization` クッキーの値。
 */
export async function fetchEdgeIdentity(
  teamDomain: string,
  identityNonce: string | null,
  cfAuthorization: string,
  fetchImpl: FetchLike = fetch,
): Promise<EdgeIdentity | null> {
  if (!cfAuthorization || !isSafeCookieValue(cfAuthorization)) return null;

  if (identityNonce) {
    const cached = await redis.get(identityCacheKey(teamDomain, identityNonce));
    if (cached) {
      try {
        return normalizeCached(JSON.parse(cached));
      } catch {
        // 壊れたキャッシュは無視して取り直す。
      }
    }
  }

  let identity: EdgeIdentity;
  try {
    const response = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/get-identity`, {
      headers: { cookie: `CF_Authorization=${cfAuthorization}` },
      // Never forward the identity cookie through an upstream redirect.
      redirect: "error",
    });
    if (!response.ok) return null;
    identity = normalize(await response.json() as RawIdentity);
  } catch {
    return null;
  }

  if (identityNonce) {
    await redis.set(
      identityCacheKey(teamDomain, identityNonce),
      JSON.stringify(identity),
      "EX",
      IDENTITY_CACHE_TTL_SEC,
    );
  }
  return identity;
}

function normalizeCached(raw: unknown): EdgeIdentity {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid cached edge identity");
  }
  const value = raw as Record<string, unknown>;
  return {
    email: typeof value.email === "string" ? value.email : null,
    name: typeof value.name === "string" && value.name.trim() !== "" ? value.name.trim() : null,
    userUuid: typeof value.userUuid === "string" ? value.userUuid : null,
    idpType: typeof value.idpType === "string" ? value.idpType : null,
    groups: normalizeGroups(value.groups),
    amr: Array.isArray(value.amr) ? value.amr.filter((item): item is string => typeof item === "string") : [],
  };
}

function normalize(raw: RawIdentity): EdgeIdentity {
  return {
    email: typeof raw.email === "string" ? raw.email : null,
    name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : null,
    userUuid: typeof raw.user_uuid === "string" ? raw.user_uuid : null,
    idpType: raw.idp && typeof raw.idp.type === "string" ? raw.idp.type : null,
    groups: normalizeGroups(raw.groups),
    amr: Array.isArray(raw.amr) ? raw.amr.filter((v): v is string => typeof v === "string") : [],
  };
}

function normalizeGroups(value: unknown): EdgeIdentityGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: EdgeIdentityGroup[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    const name = typeof record.name === "string" ? record.name : null;
    if (id === null && name === null) continue;
    groups.push({ id: id ?? name ?? "", name: name ?? id ?? "" });
  }
  return groups;
}
