/**
 * 使っている端末 A で、新しい端末 B が出した QR を開いたときの画面 (/federate/approve#t=..., account-federation §4.1-3)。
 *
 * token は fragment にあり、開いたらすぐ履歴から消す。ログインしていなければ token を sessionStorage に預けて
 * ログインへ送り、戻ってきたら続ける (token を redirect のクエリに載せない)。
 */

import { useEffect, useState } from "react";
import { ApproveRequestPanel } from "../../components/federation/ApproveRequestPanel";
import { bodyTextStyle, messageStyle, pageStyle } from "../../components/security/panel-styles";
import { useAuth } from "../../contexts/AuthContext";
import { federationApprover, federationErrorMessage, readJoinToken, type ApproverView } from "../../lib/federation-api";

const PENDING_KEY = "cernere.federation.approveToken";

/** 読み込みごとに 1 回だけ取り出す (StrictMode の二重実行で fragment と預け先の両方を空にしない)。 */
let captured: { token: string | null } | null = null;
let claimed: Promise<ApproverView> | null = null;

function takeToken(): string | null {
  if (!captured) captured = { token: readPendingToken() };
  return captured.token;
}

function readPendingToken(): string | null {
  const fromUrl = window.location.hash ? readJoinToken(window.location.href) : null;
  if (fromUrl) {
    window.history.replaceState(null, "", window.location.pathname);
    return fromUrl;
  }
  try {
    const stored = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return stored;
  } catch {
    return null;
  }
}

export function ApprovePage() {
  const { user, loading } = useAuth();
  const [view, setView] = useState<ApproverView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (loading) return;
    const token = takeToken();
    if (!user) {
      if (token) {
        try { sessionStorage.setItem(PENDING_KEY, token); } catch { /* 読み直しで続けられないだけ */ }
      }
      window.location.assign(`/login?${new URLSearchParams({ redirect: "/federate/approve" }).toString()}`);
      return;
    }
    if (!token) {
      setError("QR の情報が見つかりません。新しい端末でもう一度 QR を出し、読み直してください。");
      return;
    }
    // token は 1 回しか使えないので、同じ読み込みの中では claim の結果を共有する。
    claimed ??= federationApprover.claim(token);
    claimed.then(setView).catch((e) => setError(federationErrorMessage(e)));
  }, [user, loading]);

  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700 }}>端末の引き継ぎ</h1>
      {error && <div role="alert" style={messageStyle(true)}>{error}</div>}
      {!view && !error && <p style={bodyTextStyle}>読み込んでいます…</p>}
      {view && <ApproveRequestPanel view={view} onChange={setView} />}
      {view && (view.state === "approved" || view.state === "completed") && (
        <p style={bodyTextStyle}><a href="/settings/federation">アカウントの連携を見る</a></p>
      )}
    </main>
  );
}
