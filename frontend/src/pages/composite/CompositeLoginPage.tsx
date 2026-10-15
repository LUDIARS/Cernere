/**
 * Composite Login Page
 *
 * 他サービスから popup / 同一窓で開かれるスタンドアロンログインページ。Cernere 自身の
 * /login もこのページを使う (self モード)。認証 UI は埋め込み SDK の <CompositeLogin> を描画する。
 * 送信先検証・silent SSO・authCode の引き渡しは hooks/useCompositeLoginSession、
 * 通信は lib/composite-auth-adapter.ts が担う。
 *
 * ログインはパスキーのみで、登録とログインを区別しない (SPEC-PASSKEY-CONTINUE)。
 * 「新しく始める」は Cernere のこの origin でパスキーを作り、/onboarding (名前・リカバリー QR・
 * 別端末の追加) を済ませてからこのページへ戻る。戻ると silent SSO で authCode を渡す。
 *
 * Query params:
 *   origin       - postMessage 送信先 (popup モード)
 *   redirect_uri - リダイレクト先 (redirect モード)
 *   redirect     - self モードの戻り先 (ローカルパスのみ)
 */

import type { CSSProperties } from "react";
import { CompositeLogin } from "@ludiars/cernere-composite/ui";
import { useCompositeLoginSession } from "../../hooks/useCompositeLoginSession";
import { startUrl } from "../onboarding/onboarding-return";
import { CERNERE_LOGIN_LABELS } from "./composite-login-labels";

const API_BASE = "";

const shellStyle: CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--bg)",
};

const noticeStyle: CSSProperties = {
  width: 400,
  background: "var(--bg-surface)",
  border: "1px solid var(--red)",
  borderRadius: "var(--radius)",
  padding: "1.5rem",
  color: "var(--red)",
  fontSize: "0.9rem",
};

/** 作成後に戻る場所。self は ?redirect=、composite はこのページ自身 (silent SSO で authCode を渡す)。 */
function returnTarget(self: boolean, params: URLSearchParams): string {
  if (!self) return window.location.pathname + window.location.search;
  const redirect = params.get("redirect");
  return redirect && redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/";
}

/**
 * self モード: Cernere 単独フロントの /login がこのページをそのまま使う。
 * 認証処理は composite と共通 (authCode 発行まで同一) で、最後だけ
 * /api/auth/exchange で自分のトークンに交換してアプリへ入る。
 */
export function CompositeLoginPage({ self = false }: { self?: boolean } = {}) {
  const params = new URLSearchParams(window.location.search);
  const origin = self ? null : params.get("origin");
  const redirectUri = self ? null : params.get("redirect_uri");

  const session = useCompositeLoginSession({
    self,
    origin,
    redirectUri,
    redirectParam: params.get("redirect"),
    apiBase: API_BASE,
  });

  // パスキーが無かったら、はじめての方の画面へ。ここでは何も作らない。アカウントはその画面の
  // 「はじめる」でパスキーを作成し終えたときにできる (StartPage)。
  const createAccount = () => {
    window.location.assign(startUrl(returnTarget(self, params)));
  };

  if (session.blockedReason) {
    return (
      <div style={shellStyle}>
        <div style={noticeStyle}>{session.blockedReason}</div>
      </div>
    );
  }

  return (
    <div style={shellStyle}>
      <div style={{ width: 400 }}>
        {session.handoffError && (
          <div style={{ ...noticeStyle, width: "auto", marginBottom: "1rem" }}>{session.handoffError}</div>
        )}
        <CompositeLogin
          authApi={session.adapter}
          onAuthCode={session.deliver}
          onCreateAccount={createAccount}
          recoverUrl="/recover"
          labels={CERNERE_LOGIN_LABELS}
          passkeyAutoStart={session.passkeyAutoReady}
          style={{ maxWidth: 400 }}
        />
      </div>
    </div>
  );
}
