import { useState } from "react";
import { primaryButton, bodyTextStyle } from "../../components/security/panel-styles";
import { hasLoginCookie } from "../../lib/login-cookie";
import { startUrl } from "../onboarding/onboarding-return";

export interface LoginChoice { crossDevice: boolean; enroll: boolean }

/** The cookie only selects presentation; authentication always remains server-validated. */
export function LoginEntry({ returnTo, onLogin }: { returnTo: string; onLogin: (choice: LoginChoice) => void }) {
  const [returning] = useState(hasLoginCookie);
  const [enroll, setEnroll] = useState(true);
  const button = { ...primaryButton(false), width: "100%" };
  return <section style={{ width: "min(400px, 100%)", boxSizing: "border-box", padding: "1.5rem" }}>
    <h1>Cernere</h1>
    {returning ? <button type="button" style={button} onClick={() => onLogin({ crossDevice: false, enroll: true })}>パスキーでログイン</button> : <>
      <button type="button" style={button} onClick={() => window.location.assign(startUrl(returnTo))}>はじめて使う</button>
      <p style={bodyTextStyle}>新規アカウントで登録します</p>
      <button type="button" style={button} onClick={() => onLogin({ crossDevice: true, enroll })}>スマホでログイン</button>
      <label style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", marginTop: "0.75rem" }}>
        <input type="checkbox" checked={enroll} onChange={event => setEnroll(event.target.checked)} style={{ flexShrink: 0 }} />
        <span>この端末のパスキーを登録して連携</span>
      </label>
    </>}
    <p><a href="/recover">アカウントを復旧する</a></p>
  </section>;
}
