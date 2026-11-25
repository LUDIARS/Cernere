import { useEffect, useState, type ReactNode } from "react";
import { primaryButton, bodyTextStyle } from "../../components/security/panel-styles";
import { hasRegisteredPasskeyCookie } from "../../lib/login-cookie";
import { startUrl } from "../onboarding/onboarding-return";
import { deviceRegistration } from "../../lib/composite-device-key";
import { LoginHelp } from "./LoginHelp";

export interface LoginChoice { crossDevice: boolean; rememberDevice?: boolean; registeredDevice?: boolean }

/** The cookie only selects presentation; authentication always remains server-validated. */
export function LoginEntry({ returnTo, onLogin, busy = false, children }: { returnTo: string; onLogin: (choice: LoginChoice) => void; busy?: boolean; children?: ReactNode }) {
  const [rememberDevice, setRememberDevice] = useState(false);
  const query = new URLSearchParams(window.location.search);
  const client = query.get("code_audience") === "kiosk" ? null : query.get("client_id");
  const [serviceDevice, setServiceDevice] = useState(false);
  const [registered, setRegistered] = useState(false);
  useEffect(() => {
    if (!client) return;
    let active = true;
    void (async () => {
      const reply = await fetch("/api/auth/composite/allowed-origins");
      if (!reply.ok || (await reply.json()).deviceProof !== true) return;
      const saved = await deviceRegistration(client);
      if (active) { setServiceDevice(true); setRegistered(!!saved); }
    })().catch(() => { /* Device storage or the optional capability is unavailable. */ });
    return () => { active = false; };
  }, [client]);
  const [returning] = useState(hasRegisteredPasskeyCookie);
  const button = { ...primaryButton(busy), width: "100%", marginTop: "0.5rem", padding: "0.6rem", border: "none", borderRadius: "4px", fontWeight: 600 };
  return <section style={{ width: "100%", maxWidth: 400, background: "var(--bg-surface, #fff)", border: "1px solid var(--border, #ccc)", borderRadius: "var(--radius, 8px)", boxSizing: "border-box", padding: "2rem clamp(1rem, 5vw, 2rem)" }}>
    <LoginHelp phoneLoginAvailable={!returning} />
    <h1 style={{ textAlign: "center", fontSize: "1.5rem", fontWeight: 700, marginBottom: "1.5rem" }}>Cernere</h1>
    {serviceDevice && <>
      {registered && <button type="button" disabled={busy} onClick={() => onLogin({ crossDevice: false, registeredDevice: true })}>登録端末でログイン</button>}
      <label style={{ display: "block" }}><input type="checkbox" checked={rememberDevice} disabled={busy}
        onChange={e => setRememberDevice(e.target.checked)} />パスキーでログインしてこの端末を登録する</label>
    </>}
    {returning || rememberDevice ? <button type="button" disabled={busy} style={button} onClick={() => onLogin({ crossDevice: false, rememberDevice })}>パスキーでログイン</button> : <>
      <button type="button" disabled={busy} style={button} onClick={() => window.location.assign(startUrl(returnTo))}>はじめて使う</button>
      <p style={bodyTextStyle}>新規アカウントで登録します</p>
      <button type="button" disabled={busy} style={button} onClick={() => onLogin({ crossDevice: true })}>スマホでログイン</button>
    </>}
    {children}
    <p style={{ marginTop: "3rem", marginBottom: 0, textAlign: "right", fontSize: "0.8rem" }}><a href={`/recover?${new URLSearchParams({ return: returnTo })}`}>アカウントを復旧する</a></p>
  </section>;
}
