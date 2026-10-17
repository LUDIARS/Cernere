import { useState, type ReactNode } from "react";
import { primaryButton, bodyTextStyle } from "../../components/security/panel-styles";
import { hasLoginCookie } from "../../lib/login-cookie";
import { startUrl } from "../onboarding/onboarding-return";

export interface LoginChoice { crossDevice: boolean; enroll: boolean }

/** The cookie only selects presentation; authentication always remains server-validated. */
export function LoginEntry({ returnTo, onLogin, busy = false, children }: { returnTo: string; onLogin: (choice: LoginChoice) => void; busy?: boolean; children?: ReactNode }) {
  const [returning] = useState(hasLoginCookie);
  const [enroll, setEnroll] = useState(true);
  const button = { ...primaryButton(busy), width: "100%", marginTop: "0.5rem", padding: "0.6rem", border: "none", borderRadius: "4px", fontWeight: 600 };
  return <section style={{ width: "100%", maxWidth: 400, background: "var(--bg-surface, #fff)", border: "1px solid var(--border, #ccc)", borderRadius: "var(--radius, 8px)", boxSizing: "border-box", padding: "2rem clamp(1rem, 5vw, 2rem)" }}>
    <h1 style={{ textAlign: "center", fontSize: "1.5rem", fontWeight: 700, marginBottom: "1.5rem" }}>Cernere</h1>
    {returning ? <button type="button" disabled={busy} style={button} onClick={() => onLogin({ crossDevice: false, enroll: true })}>パスキーでログイン</button> : <>
      <button type="button" disabled={busy} style={button} onClick={() => window.location.assign(startUrl(returnTo))}>はじめて使う</button>
      <p style={bodyTextStyle}>新規アカウントで登録します</p>
      <button type="button" disabled={busy} style={button} onClick={() => onLogin({ crossDevice: true, enroll })}>スマホでログイン</button>
      <label style={{ display: "flex", alignItems: "center", flexWrap: "nowrap", gap: "0.5rem", marginTop: "0.75rem", whiteSpace: "nowrap" }}>
        {/* Override global text-input width/padding: otherwise the label is squeezed into one vertical column. */}
        <input type="checkbox" disabled={busy} checked={enroll} onChange={event => setEnroll(event.target.checked)} style={{ width: "1rem", height: "1rem", flex: "0 0 1rem", margin: 0, padding: 0, boxSizing: "border-box" }} />
        <span style={{ whiteSpace: "nowrap" }}>この端末のパスキーを登録して連携</span>
      </label>
    </>}
    {children}
    <p><a href="/recover">アカウントを復旧する</a></p>
  </section>;
}
