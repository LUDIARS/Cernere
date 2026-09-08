/**
 * Device Credential の Cookie 契約
 * (spec/plan/passkey-default-authentication.md §10.1)
 *
 * ブラウザに JS から読める長期資格情報を置かない、 が方針 (§3.1)。
 * localStorage の bearer token は XSS で丸ごと抜けるため、 HttpOnly Cookie にする。
 *
 * production は `__Host-` prefix の Cookie に限定する。 `__Host-` は Secure かつ
 * Path=/ かつ Domain 未指定を強制するので、 サブドメインからの上書き (cookie
 * tossing) を封じられる。 その代わり HTTPS が必須になる。
 */

import { config } from "../config.js";

export const DEVICE_COOKIE_NAME = "__Host-cernere-device";
/** loopback HTTP 開発時のみ使う代替名。 `__Host-` は Secure 必須で載らないため。 */
export const DEVICE_COOKIE_DEV_NAME = "cernere-device-dev";

const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * loopback の HTTP 開発を許すか。
 *
 * fail-closed で判定する。 development であること **かつ** loopback ホストで
 * あることの両方が揃った時だけ、 Secure 無しの Cookie を発行する。
 * 非 loopback や production では絶対に発行しない。
 */
export function useDevCookie(hostname: string): boolean {
  if (!config.isDevelopment) return false;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function deviceCookieName(hostname: string): string {
  return useDevCookie(hostname) ? DEVICE_COOKIE_DEV_NAME : DEVICE_COOKIE_NAME;
}

/**
 * Set-Cookie 値を組み立てる。
 *
 * SameSite=Strict にしているのは、 この Cookie が silent login という
 * 「ユーザー操作なしで認証が成立する」 経路の資格情報だから。 Lax だと
 * トップレベル遷移で送られてしまう。
 */
export function buildDeviceCookie(token: string, hostname: string, expiresAt?: Date): string {
  if (useDevCookie(hostname)) {
    // dev の loopback だけ。 session-only にして端末に長く残さない。
    return [
      `${DEVICE_COOKIE_DEV_NAME}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
    ].join("; ");
  }
  return [
    `${DEVICE_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${expiresAt ? Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) : MAX_AGE_SECONDS}`,
  ].join("; ");
}

/**
 * Cookie 削除。
 *
 * 削除は**認証上の 401 が確定した時だけ**行う (§11.4)。 network error / offline /
 * timeout / 5xx で消すと、 一時的な不通でユーザーがパスキー再認証に落ちる。
 * 属性は発行時と揃えないとブラウザが別 Cookie とみなして消えない。
 */
export function clearDeviceCookie(hostname: string): string {
  if (useDevCookie(hostname)) {
    return `${DEVICE_COOKIE_DEV_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }
  return `${DEVICE_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** Cookie ヘッダから Device Credential token を取り出す。 */
export function readDeviceCookie(cookieHeader: string, hostname: string): string | null {
  const name = deviceCookieName(hostname);
  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]*)`),
  );
  try { return match?.[1] ? decodeURIComponent(match[1]) : null; }
  catch { return null; }
}
