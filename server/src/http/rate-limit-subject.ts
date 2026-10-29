/**
 * レート制限の鍵にする接続元のまとまり。
 *
 * IPv6 は 1 契約に /64 (以上) が割り当たるので、アドレス単位で数えると 1 人が無数の枠を持てる。
 * 狭い鍵 (narrow) は 1 利用者相当として IPv4 はアドレス、IPv6 は /64 で数える。
 * 広い鍵 (wide) は全体上限の代わりに使い、IPv4 は /24、IPv6 は /48 で数える。
 * 全体で 1 枠にすると、攻撃者 1 人で全員の登録・回復を止められてしまう。
 */
import { isIPv4, isIPv6 } from "node:net";

/** IPv6 を 8 つの 16 進グループに展開する (`::` と末尾の IPv4 表記を含む)。 */
function expandIPv6(ip: string): string[] {
  let text = ip.toLowerCase();
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split(".").map(Number);
    text = text.slice(0, -dotted[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array(8 - headParts.length - tailParts.length).fill("0");
  return [...headParts, ...fill, ...tailParts].map((h) => (h || "0").replace(/^0+(?=.)/, ""));
}

function prefix(ip: string | undefined, v4Bits: 32 | 24, v6Groups: 4 | 3): string {
  if (!ip) return "anon";
  if (isIPv4(ip)) {
    if (v4Bits === 32) return ip;
    const [a, b, c] = ip.split(".");
    return `${a}.${b}.${c}.0/24`;
  }
  if (isIPv6(ip)) return `${expandIPv6(ip).slice(0, v6Groups).join(":")}::/${v6Groups * 16}`;
  return "anon";
}

/** 1 利用者相当の鍵 (IPv4 はアドレス、IPv6 は /64)。 */
export function rateLimitSubject(ip: string | undefined): string {
  return prefix(ip, 32, 4);
}

/** 全体上限の代わりの広い鍵 (IPv4 は /24、IPv6 は /48)。 */
export function wideRateLimitSubject(ip: string | undefined): string {
  return prefix(ip, 24, 3);
}
