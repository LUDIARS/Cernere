/**
 * composite ログイン完了後の authCode 引き渡し。
 *
 * <CompositeLoginPage> は認証 UI を SDK カードに任せ、 得られた authCode を
 *   - self モード: /api/auth/exchange で自分のトークンに交換してアプリへ入る
 *   - popup モード: window.opener へ postMessage
 *   - redirect モード: redirect_uri に ?code= を付けて遷移
 * のいずれかで渡す。 送信先はサーバ許可リストで直前に再検証し、 許可外へは渡さない
 * (fail-closed, VULNWEB-001)。 その判断と副作用をここに集め、 ページは描画だけにする。
 */

import { isTargetAllowed } from "./composite-redirect";

export interface CompositeAuthHandoffOptions {
  /** Cernere 単独フロントの /login (authCode を自分のトークンに交換) */
  self: boolean;
  /** popup モードの postMessage 送信先 (URL クエリ由来 = 未検証) */
  origin: string | null;
  /** redirect モードの遷移先 (URL クエリ由来 = 未検証) */
  redirectUri: string | null;
  /** self モードの戻り先 (`?redirect=`)。 ローカルパスのみ許可 */
  redirectParam: string | null;
  /** self モード: authCode → 自分のトークン交換 */
  exchange: (authCode: string) => Promise<unknown>;
  /** 引き渡しに失敗した理由の通知 (ページが表示する) */
  onError: (message: string) => void;
}

/**
 * self モードの戻り先。 open redirect を防ぐためローカルパスのみ許可。
 * @implements SPEC-COMPOSITE-AUTHCODE-HANDOFF
 */
export function resolveSelfRedirectTarget(
  redirectParam: string | null,
  currentOrigin: string = window.location.origin,
): string {
  if (!redirectParam?.startsWith("/")) return "/";
  try {
    const base = new URL(currentOrigin);
    const target = new URL(redirectParam, base);
    if (target.origin !== base.origin) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

/** @implements SPEC-COMPOSITE-AUTHCODE-HANDOFF */
export class CompositeAuthHandoff {
  /** サーバ許可リスト (composite/allowed-origins)。 取得前は空 = すべて不許可。 */
  private allowedOrigins: readonly string[] = [];

  constructor(private readonly opts: CompositeAuthHandoffOptions) {}

  setAllowedOrigins(origins: readonly string[]): void {
    this.allowedOrigins = origins;
  }

  /**
   * authCode を呼び出し元へ渡す。 失敗は onError で通知し、 例外は投げない。
   * @implements SPEC-COMPOSITE-AUTHCODE-HANDOFF
   */
  deliver(authCode: string): void {
    const { self, origin, redirectUri, redirectParam, exchange, onError } = this.opts;
    if (self) {
      // Cernere 自身がコンシューマ: authCode を自分のトークンに交換して入る
      void exchange(authCode)
        .then(() => { window.location.href = resolveSelfRedirectTarget(redirectParam); })
        .catch((err: unknown) => {
          onError(err instanceof Error ? err.message : "ログインの完了に失敗しました");
        });
      return;
    }
    // 権威はサーバ許可リスト。 postMessage/redirect の直前で必ず再検証する。
    if (origin && window.opener) {
      if (!isTargetAllowed(origin, this.allowedOrigins)) {
        onError("許可されていない送信先のため認証を中止しました。");
        return;
      }
      window.opener.postMessage({ type: "cernere:auth", authCode }, new URL(origin).origin);
      window.close();
      return;
    }
    if (redirectUri) {
      if (!isTargetAllowed(redirectUri, this.allowedOrigins)) {
        onError("許可されていないリダイレクト先のため認証を中止しました。");
        return;
      }
      const url = new URL(redirectUri);
      url.searchParams.set("code", authCode);
      window.location.href = url.toString();
      return;
    }
    onError("送信先が指定されていません。");
  }
}
