import { useState, type ReactNode } from "react";
import { primaryButton, bodyTextStyle } from "../../components/security/panel-styles";
import { hasRegisteredPasskeyCookie } from "../../lib/login-cookie";
import { startUrl } from "../onboarding/onboarding-return";

export interface LoginChoice { crossDevice: boolean; enroll: boolean }

/** The cookie only selects presentation; authentication always remains server-validated. */
export function LoginEntry({ returnTo, onLogin, busy = false, children }: { returnTo: string; onLogin: (choice: LoginChoice) => void; busy?: boolean; children?: ReactNode }) {
  const [returning] = useState(hasRegisteredPasskeyCookie);
  const [enroll, setEnroll] = useState(true);
  const button = { ...primaryButton(busy), width: "100%", marginTop: "0.5rem", padding: "0.6rem", border: "none", borderRadius: "4px", fontWeight: 600 };
  return <section style={{ width: "100%", maxWidth: 400, background: "var(--bg-surface, #fff)", border: "1px solid var(--border, #ccc)", borderRadius: "var(--radius, 8px)", boxSizing: "border-box", padding: "2rem clamp(1rem, 5vw, 2rem)" }}>
    <details style={{ marginBottom: "1rem", fontSize: "0.8rem" }}>
      <summary style={{ width: "fit-content", marginLeft: "auto", cursor: "pointer", color: "var(--accent)" }}>ヘルプ</summary>
      <div style={{ ...bodyTextStyle, marginTop: "0.75rem" }}>
        <p>はじめて使う場合は、新規アカウントを登録します。</p>
        <p>すでにアカウントがある場合は、スマホのパスキーでログインできます。チェックを入れると、ログイン後にこの端末のパスキー登録へ進みます。</p>
        <p>パスキーが使えない場合は、右下の「アカウントを復旧する」へ進んでください。</p>
      </div>
    </details>
    <h1 style={{ textAlign: "center", fontSize: "1.5rem", fontWeight: 700, marginBottom: "1.5rem" }}>Cernere</h1>
    {returning ? <button type="button" disabled={busy} style={button} onClick={() => onLogin({ crossDevice: false, enroll: true })}>パスキーでログイン</button> : <>
      <button type="button" disabled={busy} style={button} onClick={() => window.location.assign(startUrl(returnTo))}>はじめて使う</button>
      <p style={bodyTextStyle}>新規アカウントで登録します</p>
      <button type="button" disabled={busy} style={button} onClick={() => onLogin({ crossDevice: true, enroll })}>スマホでログイン</button>
      <p id="smartphone-enrollment-context" style={{ ...bodyTextStyle, marginTop: "0.75rem", marginBottom: "0.25rem" }}>スマホでログインする場合、</p>
      <label style={{ display: "flex", alignItems: "center", flexWrap: "nowrap", gap: "0.5rem", whiteSpace: "nowrap" }}>
        {/* Override global text-input width/padding: otherwise the label is squeezed into one vertical column. */}
        <input type="checkbox" aria-describedby="smartphone-enrollment-context" disabled={busy} checked={enroll} onChange={event => setEnroll(event.target.checked)} style={{ width: "1rem", height: "1rem", flex: "0 0 1rem", margin: 0, padding: 0, boxSizing: "border-box" }} />
        <span style={{ whiteSpace: "nowrap" }}>この端末のパスキーを登録して連携</span>
      </label>
    </>}
    {children}
    <p style={{ marginTop: "3rem", marginBottom: 0, textAlign: "right", fontSize: "0.8rem" }}><a href={`/recover?${new URLSearchParams({ return: returnTo })}`}>アカウントを復旧する</a></p>
  </section>;
}
