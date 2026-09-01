/**
 * Composite Login Page
 *
 * 他サービスから popup / 同一窓で開かれるスタンドアロンログインページ。 認証 UI は
 * 埋め込み SDK の <CompositeLogin> (packages/composite) をそのまま描画する。
 * 送信先検証・silent SSO・authCode の引き渡しは hooks/useCompositeLoginSession、
 * 通信は lib/composite-auth-adapter.ts (REST + composite WS) が担う。
 *
 * Query params:
 *   origin       - postMessage 送信先 (popup モード)
 *   redirect_uri - リダイレクト先 (redirect モード)
 *   auth_mode    - "passkey" でパスワード導線を出さない
 *   mode         - "login" | "register" の初期タブ
 *   redirect     - self モードの戻り先 (ローカルパスのみ)
 */

import type { CSSProperties } from "react";
import { CompositeLogin } from "@ludiars/cernere-composite/ui";
import { useAuth } from "../../contexts/AuthContext";
import { useCompositeLoginSession } from "../../hooks/useCompositeLoginSession";
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

/**
 * self モード: Cernere 単独フロントの /login がこのページをそのまま使う (ダブスタ解消)。
 * 認証処理は composite と共通 (authCode 発行まで同一) で、 最後だけ
 * /api/auth/exchange で自分のトークンに交換してアプリへ入る。
 */
export function CompositeLoginPage({ self = false }: { self?: boolean } = {}) {
  const params = new URLSearchParams(window.location.search);
  const origin = self ? null : params.get("origin");
  const redirectUri = self ? null : params.get("redirect_uri");
  // passkey 指定時は端末種別にかかわらずパスワードへ暗黙フォールバックしない。
  const passkeyOnly = !self && params.get("auth_mode") === "passkey";
  const { googleAuthUrl: selfGoogleUrl, githubAuthUrl: selfGithubUrl } = useAuth();

  const session = useCompositeLoginSession({
    self,
    origin,
    redirectUri,
    redirectParam: params.get("redirect"),
    modeParam: params.get("mode"),
    apiBase: API_BASE,
  });

  // OAuth URL に composite_origin を付与
  const compositeParam = origin
    ? `composite_origin=${encodeURIComponent(origin)}`
    : redirectUri
      ? `composite_origin=${encodeURIComponent(redirectUri)}`
      : "";
  const googleAuthUrl = self ? selfGoogleUrl : `/auth/google/login${compositeParam ? `?${compositeParam}` : ""}`;
  const githubAuthUrl = self ? selfGithubUrl : `/auth/github/login${compositeParam ? `?${compositeParam}` : ""}`;

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
          oauth={passkeyOnly ? undefined : { googleUrl: googleAuthUrl, githubUrl: githubAuthUrl }}
          labels={CERNERE_LOGIN_LABELS}
          initialMode={session.initialMode}
          passkeyOnly={passkeyOnly}
          passkeyAutoStart={session.passkeyAutoReady}
          style={{ maxWidth: 400 }}
        />
      </div>
    </div>
  );
}
