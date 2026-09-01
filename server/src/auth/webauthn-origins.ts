/**
 * WebAuthn ceremony を受け付ける origin の集合。
 *
 * パスキー ceremony は「ページを開いている origin」で実行される。 Cernere 自身の
 * フロント (WEBAUTHN_ORIGINS / FRONTEND_URL) に加え、 埋め込み SDK
 * (`@ludiars/cernere-composite/ui` の <CompositeLogin>) を描画する first-party
 * サービスの origin でも ceremony が走るため、 composite の authCode 送信先許可
 * リスト (CERNERE_COMPOSITE_ALLOWED_ORIGINS) を expectedOrigin に合流させる。
 *
 * 前提: RP ID (WEBAUTHN_RP_ID) はそれら全 origin の registrable suffix でなければ
 * ブラウザ側が ceremony を拒否する (例: RP ID = example.com、 サービスは
 * app.example.com)。 別 eTLD+1 のサービスは埋め込みではなく
 * <CompositePasskeyPopup> (Cernere origin で ceremony) を使う。
 */

/** 文字列を origin (scheme://host[:port]) に正規化する。 解釈不能・opaque は捨てる。 */
function toOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const origin = url.origin;
    return origin && origin !== "null" ? origin : null;
  } catch {
    return null;
  }
}

/**
 * WebAuthn 用 origin と composite 許可 origin を正規化・重複排除して合流させる。
 * 順序は入力順 (webauthn → composite) を保つ。
 */
export function mergeWebauthnOrigins(
  webauthnOrigins: readonly string[],
  compositeAllowedOrigins: readonly string[],
): string[] {
  const merged = new Set<string>();
  for (const raw of [...webauthnOrigins, ...compositeAllowedOrigins]) {
    const origin = toOrigin(raw);
    if (origin) merged.add(origin);
  }
  return Array.from(merged);
}
