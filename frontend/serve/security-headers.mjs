// 外部公開する画面の応答に付けるヘッダ。CSP の frame-ancestors は frame-policy.mjs が別に付ける。

/** frame-ancestors に足す CSP。プラグイン埋め込みと <base> の差し替えを禁じる (画面の挙動は変えない)。 */
export const EXTRA_CSP = "object-src 'none'; base-uri 'self'";
export const SECURITY_HEADERS = Object.freeze({
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // Cross-Origin-Opener-Policy は付けない。GLAB 等がポップアップで開くログイン画面は
  // window.opener へ authCode を返すので、COOP で opener が切れると Composite ログインが壊れる。
});
