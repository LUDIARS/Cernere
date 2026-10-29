/**
 * レート制限・監査に使う接続元 IP の決定。
 *
 * 外部公開経路は Cloudflare → cloudflared → (frontend の配信サーバ) → Cernere で、
 * ソケットの相手は常にループバックになる。 そのままだと IP 単位のレート制限が
 * 全利用者で 1 つの枠になり、 攻撃者 1 人で登録・復旧を全員分止められる。
 *
 * ヘッダは偽造できるので、 相手が CERNERE_TRUSTED_PROXIES に列挙したアドレスの
 * ときだけ CF-Connecting-IP を採る (未設定ならヘッダを一切信用しない)。
 * X-Forwarded-For は経路ごとに積み方が違い、 先頭は利用者が自由に書けるため使わない。
 */
import { isIP } from "node:net";

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** IPv4-mapped IPv6 (`::ffff:127.0.0.1`) を素の IPv4 に揃え、 IP でなければ undefined。 */
export function normalizeIp(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const mapped = MAPPED_V4.exec(value);
  const ip = mapped ? mapped[1] : value;
  return isIP(ip) ? ip.toLowerCase() : undefined;
}

/** CERNERE_TRUSTED_PROXIES (カンマ区切りの IP)。 不正な値は起動を止める。 */
export function readTrustedProxies(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const raw = env.CERNERE_TRUSTED_PROXIES?.trim();
  if (!raw) return new Set();
  return new Set(raw.split(",").map((entry) => {
    const ip = normalizeIp(entry);
    if (!ip) throw new Error(`CERNERE_TRUSTED_PROXIES must list IP addresses: ${entry.trim() || "(empty)"}`);
    return ip;
  }));
}

/** 信頼するプロキシ経由なら CF-Connecting-IP、 それ以外はソケットの相手。 */
export function resolveClientIp(
  peer: string | undefined,
  cfConnectingIp: string | undefined,
  trustedProxies: ReadonlySet<string>,
): string | undefined {
  const peerIp = normalizeIp(peer);
  if (!peerIp || !trustedProxies.has(peerIp)) return peerIp;
  return normalizeIp(cfConnectingIp) ?? peerIp;
}
