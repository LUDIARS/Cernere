import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { startRegistration, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";

export function PasskeyRecoveryPage() {
  const [token, setToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "");
  const [busy, setBusy] = useState(false), [done, setDone] = useState(false), [error, setError] = useState("");
  useEffect(() => { window.history.replaceState({}, "", window.location.pathname); }, []);
  async function recover() {
    setBusy(true); setError("");
    async function request<T>(action: string, body: unknown): Promise<T> {
      const response = await fetch((import.meta.env.VITE_API_BASE ?? "") + "/api/auth/passkey/" + action,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "回復に失敗しました。管理者へご連絡ください。");
      return data as T;
    }
    try {
      const begin = await request<{ ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }>("recovery-begin", { token });
      const response = await startRegistration({ optionsJSON: begin.options });
      await request("recovery-finish", { token, ceremonyId: begin.ceremonyId, response });
      setToken(""); setDone(true);
    } catch (e) { setError(e instanceof Error ? e.message : "回復に失敗しました。"); }
    finally { setBusy(false); }
  }
  return <main style={{ maxWidth: "36rem", margin: "3rem auto", padding: "1rem" }}>
    <h1>パスキーの回復</h1>
    {done ? <><p>新しいパスキーを登録し、以前のセッションを失効しました。新しいパスキーでログインしてください。</p><Link to="/login">ログインへ</Link></> : <>
      <p>管理者が本人確認後に発行した回復用トークンを使います。登録が完了すると、管理者が指定した古いパスキーと、以前のログインセッションが失効します。</p>
      <label>回復用トークン<input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} disabled={busy} /></label>
      <button onClick={() => void recover()} disabled={busy || !token}>新しいパスキーを登録</button>
      {error && <p role="alert">{error}</p>}
    </>}
  </main>;
}
