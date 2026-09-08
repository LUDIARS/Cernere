/** Authenticator QR enrollment and email factor settings. @implements SPEC-MFA-SETTINGS */
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { mfaApi, type MfaStatus, type MfaMethod, type TotpSetup } from "../lib/mfa-api";
import { MfaAuthorization } from "./MfaAuthorization";

export function MfaSettingsSection({ userId }: { userId: string }) {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [token, setToken] = useState("");
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [qr, setQr] = useState("");
  const [emailPending, setEmailPending] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0);

  const clear = useCallback(() => { generation.current += 1; setToken(""); setSetup(null); setQr(""); setCode(""); setEmailPending(false); setBusy(false); }, []);
  const reload = useCallback(async () => {
    const started = generation.current;
    try {
      const next = await mfaApi.status();
      if (generation.current === started) setStatus(next);
    } catch (error) {
      if (generation.current === started) { setStatus(null); setMessage(error instanceof Error ? error.message : "MFA 設定を取得できませんでした。"); }
    }
  }, []);
  useEffect(() => {
    clear(); void reload();
    return () => { generation.current += 1; };
  }, [reload, userId, clear]);
  useEffect(() => {
    if (!token) return;
    const timer = window.setTimeout(() => { clear(); setMessage("本人確認の有効期限が切れました。もう一度確認してください。"); }, 300_000);
    return () => window.clearTimeout(timer);
  }, [token, clear]);

  async function prepare(method: MfaMethod) {
    const started = generation.current;
    setBusy(true); setMessage(""); setCode("");
    try {
      if (method === "totp") {
        const result = await mfaApi.totpSetup(token);
        const image = await QRCode.toDataURL(result.provisioningUri, { width: 240, margin: 2 });
        if (generation.current !== started) return;
        setSetup(result); setQr(image); setEmailPending(false);
      } else {
        await mfaApi.emailSetup(token);
        if (generation.current !== started) return;
        setSetup(null); setQr(""); setEmailPending(true);
        setMessage("登録メールへコードを送信しました。再送は60秒後から可能です。");
      }
    } catch (error) { if (generation.current === started) setMessage(error instanceof Error ? error.message : "登録を開始できませんでした。"); }
    finally { if (generation.current === started) setBusy(false); }
  }

  async function change(method: MfaMethod, enable: boolean) {
    if (!enable && !window.confirm(`${method === "totp" ? "Authenticator" : "メール"} の追加認証を解除しますか？`)) return;
    const started = generation.current;
    setBusy(true); setMessage("");
    try {
      await mfaApi.change(token, method, enable, code);
      if (generation.current !== started) return;
      clear();
      const completed = generation.current;
      await reload();
      if (generation.current === completed) setMessage("MFA 設定を更新しました。既存のログイン更新権限を失効したため、次回はログインし直してください。");
    } catch (error) { if (generation.current === started) setMessage(error instanceof Error ? error.message : "設定を変更できませんでした。"); }
    finally { if (generation.current === started) { setBusy(false); setCode(""); } }
  }

  return <section style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "1.5rem", marginTop: "1rem" }}>
    <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>二段階認証（MFA）</h2>
    <p>パスワードでログインするときに、Authenticator アプリまたはメールのコードで追加確認します。</p>
    <p>Authenticator を使えなくなった場合に備え、パスキーやメールの確認方法も登録しておいてください。</p>
    {message && <p role="status" style={{ margin: "0.75rem 0", overflowWrap: "anywhere" }}>{message}</p>}
    {!status ? <button type="button" onClick={() => { void reload(); }}>設定を再取得</button> : <>
      <p>Authenticator: {status.totpEnabled ? "有効" : "未登録"} ／ メール: {status.emailEnabled ? "有効" : "無効"}</p>
      {!token ? <MfaAuthorization userId={userId} status={status} onAuthorized={(value) => { clear(); setToken(value); setMessage(""); }} /> : <>
        <p>本人確認済みです。5分以内に設定を1件変更できます。</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", margin: "0.75rem 0" }}>
          {status.totpEnabled
            ? <button type="button" disabled={busy} onClick={() => { void change("totp", false); }}>Authenticator を解除</button>
            : <button type="button" disabled={busy || !status.totpAvailable} onClick={() => { void prepare("totp"); }}>Authenticator を登録</button>}
          {status.emailEnabled
            ? <button type="button" disabled={busy} onClick={() => { void change("email", false); }}>メール MFA を解除</button>
            : <button type="button" disabled={busy || !status.hasEmail || !status.emailMfaAvailable} onClick={() => { void prepare("email"); }}>メール MFA を登録</button>}
        </div>
        {!status.totpAvailable && <p>Authenticator の登録には、サーバー側の暗号化設定が必要です。</p>}
        {(!status.hasEmail || !status.emailMfaAvailable) && <p>メール MFA にはメールアドレスとサーバーの送信設定が必要です。</p>}
        {setup && <div>
          <p>Google Authenticator / Microsoft Authenticator などで QR を読み取ってください。</p>
          {qr && <img src={qr} width={240} height={240} alt="Authenticator 登録用 QR コード" />}
          <details><summary>手動入力用キー</summary><code style={{ overflowWrap: "anywhere" }}>{setup.secret}</code></details>
          <p>このキーや QR を他人と共有しないでください。</p>
        </div>}
        {(setup || emailPending) && <form onSubmit={(event) => { event.preventDefault(); void change(setup ? "totp" : "email", true); }}>
          <label>6桁の確認コード <input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required disabled={busy} /></label>
          <button type="submit" disabled={busy}>コードを確認して有効にする</button>
          {emailPending && <button type="button" disabled={busy} onClick={() => { void prepare("email"); }}>メールを再送</button>}
        </form>}
        <button type="button" disabled={busy} onClick={clear}>設定を閉じる</button>
      </>}
    </>}
  </section>;
}
