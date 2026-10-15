/**
 * はじめての方の入口 (アカウント作成前)。
 *
 * 名前を入れて「はじめる」を押すと、この端末にパスキーを作成し、作成を終えたときに
 * アカウントができる (neco 2026-10-15「はじめるでアカウント作成」)。この画面を開いただけ・
 * 名前を入れただけでは何も作らない。作成後はオンボーディング (リカバリー QR・スマホ・通知) へ進む。
 */

import { useState } from "react";
import { bodyTextStyle, inputStyle, messageStyle, pageStyle, panelStyle, panelTitleStyle, primaryButton, secondaryButton } from "../../components/security/panel-styles";
import { signupWithPasskey } from "../../lib/passkey-account-api";
import { MAX_DISPLAY_NAME, normalizeDisplayName, savePendingDisplayName } from "../../lib/pending-display-name";
import { onboardingUrl, readReturnPath } from "./onboarding-return";

export function StartPage() {
  const returnTo = readReturnPath(window.location.search);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valid = normalizeDisplayName(name) !== null;

  const start = async () => {
    const normalized = normalizeDisplayName(name);
    if (!normalized) return;
    setBusy(true);
    setError("");
    savePendingDisplayName(normalized);
    try {
      await signupWithPasskey();
      // AuthContext に新しいセッションを読ませるため、全体を読み直して遷移する。
      window.location.assign(onboardingUrl(returnTo));
    } catch (e) {
      const err = e as Error;
      setError(err.name === "NotAllowedError" || err.name === "AbortError"
        ? "パスキーの作成が完了しませんでした。アカウントは作られていません。もう一度「はじめる」を押してください。"
        : err.message);
      setBusy(false);
    }
  };

  const back = () => {
    window.location.assign(`/login?${new URLSearchParams({ redirect: returnTo }).toString()}`);
  };

  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700 }}>Cernere をはじめる</h1>
      <div style={panelStyle}>
        <h2 style={panelTitleStyle}>👤 名前</h2>
        <p style={bodyTextStyle}>Cernere とつながるサービスに表示される名前です。あとから変えられます。</p>
        {error && <div role="alert" style={messageStyle(true)}>{error}</div>}
        <input
          value={name}
          maxLength={MAX_DISPLAY_NAME}
          autoComplete="nickname"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && valid && !busy) void start(); }}
          placeholder="表示名"
          style={inputStyle}
        />
        <p style={{ ...bodyTextStyle, marginTop: "0.75rem" }}>
          「はじめる」を押すと、この端末にパスキーを作成します。作成を終えたときにアカウントができます。
        </p>
        <button type="button" onClick={() => { void start(); }} disabled={busy || !valid} style={{ ...primaryButton(busy || !valid), marginTop: "0.5rem" }}>
          {busy ? "パスキーの作成を待っています…" : "はじめる"}
        </button>
      </div>
      <button type="button" onClick={back} disabled={busy} style={secondaryButton(busy)}>
        パスキーを持っている (ログインに戻る)
      </button>
    </main>
  );
}
