/**
 * Cloudflare Access の署名鍵 (JWKS) 取得とキャッシュ
 *
 * spec/feature/edge-assertion-login.md §6。
 *
 * 取得先は `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`。
 * CF は鍵をローテーションするため、 未知の `kid` を見たときだけ強制再取得する。
 * ただし未知 kid を投げ続ける攻撃で CF への問い合わせが増幅しないよう、
 * 強制再取得は team domain ごとに 1 分 1 回までに制限する。
 *
 * 取得失敗時はキャッシュで継続し、 キャッシュも無ければ null を返す
 * (呼び出し側が fail-closed で拒否する)。
 */

import { createPublicKey, type JsonWebKey, type KeyObject } from "node:crypto";

/** JWKS の通常キャッシュ期間。 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** 未知 kid をきっかけにした強制再取得の下限間隔。 */
const FORCED_REFRESH_MIN_INTERVAL_MS = 60 * 1000;

interface JwksResponse {
  keys?: JsonWebKey[];
}

interface CachedJwks {
  keys: Map<string, KeyObject>;
  fetchedAt: number;
}

export type FetchLike = typeof fetch;

const cache = new Map<string, CachedJwks>();
const lastFetchAttemptAt = new Map<string, number>();

/**
 * team domain と kid に対応する公開鍵を返す。 見つからなければ null。
 *
 * @param teamDomain `<team>.cloudflareaccess.com` (スキーム無し)
 */
export async function getEdgeSigningKey(
  teamDomain: string,
  kid: string,
  now: number = Date.now(),
  fetchImpl: FetchLike = fetch,
): Promise<KeyObject | null> {
  const cached = cache.get(teamDomain);
  const fresh = cached !== undefined && now - cached.fetchedAt < CACHE_TTL_MS;

  if (cached && fresh) {
    const hit = cached.keys.get(kid);
    if (hit) return hit;
  }

  if (!shouldFetch(teamDomain, cached, now)) {
    // レート制限に掛かっている間は、 期限切れキャッシュでも使えるものは使う。
    return cached?.keys.get(kid) ?? null;
  }

  lastFetchAttemptAt.set(teamDomain, now);
  try {
    const keys = await fetchJwks(teamDomain, fetchImpl);
    cache.set(teamDomain, { keys, fetchedAt: now });
    return keys.get(kid) ?? null;
  } catch {
    // 取得できなければキャッシュで継続する。 キャッシュも無ければ null = 拒否。
    return cached?.keys.get(kid) ?? null;
  }
}

/**
 * 取得しに行くべきかを判定する。
 *
 * - キャッシュが無い: 常に取得する (初回)
 * - キャッシュが期限切れ / kid が未知: 1 分 1 回までに制限して取得する
 *
 * 期限切れ側にも間隔制限を掛けるのは、 CF 側が落ちている間は取得が失敗して
 * `fetchedAt` が更新されないため。 制限が無いとアサーションが来るたびに CF へ
 * 問い合わせ続けることになる (未知 kid の連打と同じ増幅経路)。
 */
function shouldFetch(
  teamDomain: string,
  cached: CachedJwks | undefined,
  now: number,
): boolean {
  if (!cached) return true;
  const lastAttempt = lastFetchAttemptAt.get(teamDomain) ?? 0;
  return now - lastAttempt >= FORCED_REFRESH_MIN_INTERVAL_MS;
}

async function fetchJwks(teamDomain: string, fetchImpl: FetchLike): Promise<Map<string, KeyObject>> {
  const response = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`, {
    redirect: "error",
  });
  if (!response.ok) throw new Error(`JWKS fetch failed: ${response.status}`);

  const body = await response.json() as JwksResponse;
  if (!Array.isArray(body.keys)) throw new Error("JWKS response has no keys array");

  const keys = new Map<string, KeyObject>();
  for (const jwk of body.keys) {
    // 署名検証にしか使わないので RSA 以外と暗号用の鍵は取り込まない。
    if (typeof jwk.kid !== "string" || jwk.kty !== "RSA" || jwk.use === "enc") continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
    } catch {
      // 壊れた鍵が 1 本混ざっていても残りは使う。
    }
  }
  if (keys.size === 0) throw new Error("JWKS response has no usable RSA signing key");
  return keys;
}

/** テスト用。 プロセス内キャッシュを空にする。 */
export function resetEdgeJwksCache(): void {
  cache.clear();
  lastFetchAttemptAt.clear();
}
