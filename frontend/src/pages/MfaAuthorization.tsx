/** Fresh authentication before changing MFA; a login session alone is insufficient. */
import { useState } from "react";
import { mfaApi, type MfaChallenge, type MfaMethod, type MfaStatus } from "../lib/mfa-api";

export function MfaAuthorization({ userId, status, onAuthorized }: {
  userId: string; status: MfaStatus; onAuthorized(token: string): void;
}) {
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [method, setMethod] = useState<MfaMethod>("totp");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function begin(passkey: boolean) {
    setBusy(true); setMessage("");
    try {
      const result = passkey ? await mfaApi.beginWithPasskey(userId) : await mfaApi.begin(password);
      setPassword("");
      if ("managementToken" in result) onAuthorized(result.managementToken);
      else { setChallenge(result); setMethod(result.mfaMethods[0] ?? "totp"); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "本人確認に失敗しました。"); }
    finally { setBusy(false); }
  }

  async function verify() {
    if (!challenge) return;
    setBusy(true); setMessage("");
    try { onAuthorized((await mfaApi.verify(challenge.mfaToken, method, code)).managementToken); }
    catch (error) { setMessage(error instanceof Error ? error.message : "コードを確認できませんでした。"); }
    finally { setBusy(false); setCode(""); }
  }

  async function send() {
    if (!challenge) return;
    setBusy(true); setMessage("");
    try { await mfaApi.send(challenge.mfaToken); setMessage("登録メールへ送りました。再送は60秒後から可能です。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "送信できませんでした。"); }
    finally { setBusy(false); }
  }

  return <div>
    <p>設定を変更するには、本人確認を行ってください。</p>
    {message && <p role="status">{message}</p>}
    {challenge ? <form onSubmit={(event) => { event.preventDefault(); void verify(); }}>
      <label>現在の確認方法 <select value={method} disabled={busy} onChange={(event) => { setMethod(event.target.value as MfaMethod); setCode(""); setMessage(""); }}>
        {challenge.mfaMethods.map((item) => <option key={item} value={item}>{item === "totp" ? "Authenticator アプリ" : "メール"}</option>)}
      </select></label>
      {method === "email" && <button type="button" disabled={busy} onClick={() => { void send(); }}>コードを送信</button>}
      <label>6桁のコード <input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required disabled={busy} /></label>
      <button type="submit" disabled={busy}>本人確認を完了</button>
      <button type="button" disabled={busy} onClick={() => { setChallenge(null); setCode(""); }}>最初からやり直す</button>
      <p>開始から5分以内に入力してください。Authenticator の同じコードは再利用できません。</p>
    </form> : <>
      {status.hasPassword && <form onSubmit={(event) => { event.preventDefault(); void begin(false); }}>
        <label>現在のパスワード <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required maxLength={1024} disabled={busy} /></label>
        <button type="submit" disabled={busy}>パスワードで本人確認</button>
      </form>}
      {status.hasPasskey && <button type="button" disabled={busy} onClick={() => { void begin(true); }}>パスキーで本人確認</button>}
      {!status.hasPassword && !status.hasPasskey && <p>先に、このプロフィール画面でパスキーを登録してください。</p>}
    </>}
  </div>;
}
