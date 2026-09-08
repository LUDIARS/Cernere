import { useState } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { wsClient } from "../../lib/ws-client";

interface Grant { grantId: string; token: string; expiresAt: string }
export function AccountRecoveryPage() {
  const { user, wsConnected } = useAuth();
  const [userId, setUserId] = useState(""), [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false);
  const [grant, setGrant] = useState<Grant | null>(null);
  if (user?.role !== "admin") return <p>管理者のみ利用できます。</p>;
  async function issue() {
    setBusy(true); setError(""); setGrant(null);
    try { setGrant(await wsClient.sendCommand<Grant>("account_recovery", "issue", { userId, revokeAllExistingPasskeys: true })); }
    catch (e) { setError(e instanceof Error ? e.message : "発行に失敗しました。"); }
    finally { setBusy(false); }
  }
  async function revoke() {
    if (!grant) return;
    setBusy(true); setError("");
    try { await wsClient.sendCommand("account_recovery", "revoke", { grantId: grant.grantId }); setGrant(null); }
    catch (e) { setError(e instanceof Error ? e.message : "取り消しに失敗しました。"); }
    finally { setBusy(false); }
  }
  return <section><h1>アカウントの回復</h1>
    <p>別の窓口で本人確認を完了した利用者に、15 分間有効な回復リンクを発行します。回復が完了すると既存の全パスキーとログインセッションが失効します。</p>
    <label>対象ユーザー ID<input value={userId} onChange={e => { setUserId(e.target.value); setConfirmed(false); }} disabled={busy} /></label>
    <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={busy} />本人確認と失効範囲の確認を完了しました</label>
    <button onClick={() => void issue()} disabled={busy || !confirmed || !wsConnected || !userId}>再認証して回復リンクを発行</button>
    {error && <p role="alert">{error}</p>}
    {grant && <div><p>このリンクは再表示できません。本人確認を行った窓口から対象者へ渡してください。</p>
      <label>回復リンク<input readOnly value={window.location.origin + "/recover#token=" + encodeURIComponent(grant.token)} onFocus={e => e.target.select()} /></label>
      <p>期限: {new Date(grant.expiresAt).toLocaleString()}</p>
      <button onClick={() => void revoke()} disabled={busy || !wsConnected}>再認証して発行を取り消す</button>
    </div>}
  </section>;
}
