/**
 * Composite 認証フローの redirect 先検証。
 *
 * composite ログインは認証成功後に authCode を「呼び出し元が指定した送信先」
 * (postMessage の origin / redirect_uri) へ返す。 この送信先は呼び出し元 URL の
 * クエリ由来で攻撃者が細工しうるため、 完全一致の origin 許可リストで検証する。
 * 検証を怠ると、 攻撃者が被害者を `?redirect_uri=https://evil` へ誘導するだけで
 * one-time authCode を奪い、 `POST /api/auth/exchange` でトークンを窃取できる
 * (VULNWEB-001)。
 *
 * 権威はサーバ側の許可リスト (config.compositeAllowedOrigins)。 フロントの検証は
 * この許可リストを取得して行う二次防御であり、 単独では信頼しない。
 */

import { config } from "../config.js";

/**
 * target (origin 文字列 or 完全 URL) の **origin** が許可リストに完全一致するか。
 * 純粋関数 (config 非依存) — テスト・呼び出し側で許可リストを差し替え可能。
 *
 * - パース不能 / 空 → false
 * - opaque origin ("null": javascript:, data:, about:blank 等) → false
 * - path / query / fragment は無視し origin 部分のみで判定
 */
export function isOriginAllowed(
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

/** config の許可リストで target を検証する実運用向けラッパ。 */
export function isCompositeTargetAllowed(target: string | null | undefined): boolean {
  return isOriginAllowed(target, config.compositeAllowedOrigins);
}

/** フロントへ公開する許可リスト (完全一致 origin の配列)。 */
export function compositeAllowedOrigins(): string[] {
  return [...config.compositeAllowedOrigins];
}
