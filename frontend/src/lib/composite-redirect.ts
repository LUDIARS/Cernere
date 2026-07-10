/**
 * Composite 認証の redirect 先検証 (フロント側)。
 *
 * authCode を postMessage の origin / redirect_uri へ返す前に、 サーバの許可リスト
 * (`GET /api/auth/composite/allowed-origins`) と照合する。 権威はサーバ側であり、
 * 攻撃者は URL クエリを細工できてもこの許可リストは変えられないため、 フロントで
 * 弾くだけでも authCode の漏洩を防げる (VULNWEB-001)。 取得失敗時は fail-closed。
 */

/** サーバから許可 origin リストを取得する。 失敗時は空配列 (= すべて不許可)。 */
export async function fetchAllowedOrigins(): Promise<string[]> {
  try {
    const res = await fetch("/api/auth/composite/allowed-origins");
    if (!res.ok) return [];
    const data = (await res.json()) as { origins?: string[] };
    return Array.isArray(data.origins) ? data.origins : [];
  } catch {
    return [];
  }
}

/** target (origin 文字列 or 完全 URL) の origin が許可リストに完全一致するか。 */
export function isTargetAllowed(
  target: string | null | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (!target) return false;
  let origin: string;
  try {
    origin = new URL(target).origin;
  } catch {
    return false;
  }
  if (!origin || origin === "null") return false;
  return allowedOrigins.includes(origin);
}
