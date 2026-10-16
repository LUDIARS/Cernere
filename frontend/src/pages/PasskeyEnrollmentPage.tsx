import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { auth } from "../lib/api";
import { resolveSelfRedirectTarget } from "../lib/composite-auth-handoff";
import { passkeyEnrollmentUrl } from "../lib/passkey-enrollment";
import { bodyTextStyle, pageStyle, primaryButton, secondaryButton } from "../components/security/panel-styles";

/** Add a platform credential to the signed-in account without requiring federation. */
export function PasskeyEnrollmentPage() {
  const { user } = useAuth();
  const returnTo = resolveSelfRedirectTarget(new URLSearchParams(window.location.search).get("return"));
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const check = window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable;
    if (!check) { setAvailable(false); return; }
    void check.call(window.PublicKeyCredential)
      .then((value) => { if (!cancelled) setAvailable(value); })
      .catch(() => { if (!cancelled) setAvailable(false); });
    return () => { cancelled = true; };
  }, []);

  if (!user) {
    const params = new URLSearchParams({ redirect: passkeyEnrollmentUrl(returnTo), cross_device: "1" });
    return <Navigate to={`/login?${params}`} replace />;
  }

  const register = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await auth.passkeyRegister("この端末", { platformOnly: true });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "登録できませんでした。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: "1.4rem" }}>この端末にパスキーを登録</h1>
      <p style={bodyTextStyle}>ログイン中の「{user.name || "あなたのアカウント"}」に追加します。次回から、この端末の Windows Hello や Touch ID などでログインできます。</p>
      {!saved && <p style={bodyTextStyle}>自分専用の端末で登録してください。登録前に、今お使いのパスキーで本人確認を求められる場合があります。その後、この端末への保存を選びます。</p>}
      {error && <p role="alert" style={{ color: "var(--red)" }}>{error}</p>}
      {saved ? <p role="status">この端末にパスキーを登録しました。</p> : (
        <>
          {available === null && <p role="status">この端末で登録できるか確認しています…</p>}
          {available === false && <p role="status">この環境では端末内のパスキー登録を利用できません。Windows Hello・Touch ID の設定や対応ブラウザを確認してください。登録せずに続けることもできます。</p>}
          <button type="button" disabled={busy || available !== true} style={primaryButton(busy || available !== true)} onClick={() => { void register(); }}>
            {busy ? "登録中…" : "この端末に登録する"}
          </button>
        </>
      )}
      <p style={bodyTextStyle}>アカウントの連携は、あとから設定できます。今回の登録では、名前やサービスの記録は変わりません。</p>
      <button type="button" disabled={busy} style={secondaryButton(busy)} onClick={() => window.location.assign(returnTo)}>
        {saved ? "元の画面へ進む" : "今は登録せずに進む"}
      </button>
      {saved && <p><Link to="/settings/federation">アカウントの連携を設定する（任意）</Link></p>}
    </main>
  );
}
