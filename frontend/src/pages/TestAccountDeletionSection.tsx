import { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { wsClient } from "../lib/ws-client";

/** @implements SPEC-HQ-TEST-ACCOUNT-DELETION */
export function TestAccountDeletionSection() {
  const { user, wsConnected, logout } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setEnabled(false);
    if (wsConnected) {
      void wsClient.sendCommand<{ enabled: boolean }>("user", "test_account_deletion")
        .then(result => { if (active) setEnabled(result.enabled); })
        .catch(() => { /* Capability unavailable: never expose destructive test controls. */ });
    }
    return () => { active = false; };
  }, [wsConnected, user?.id]);
  if (!enabled || !wsConnected) return null;

  async function deleteAccount() {
    if (busy || confirmation !== "DELETE") return;
    setBusy(true);
    setError("");
    try {
      await wsClient.sendCommand("user", "delete_account", { hqTest: true, confirmation });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "削除できませんでした。");
      setBusy(false);
      return;
    }
    // Deletion has completed; a logout failure must not offer a second deletion.
    try { await logout(); }
    catch { /* The deleted account can no longer authenticate logout; leave the page. */ }
    finally { window.location.assign("/login"); }
  }

  return <section style={{ border: "1px solid var(--red)", padding: "1.5rem", marginTop: "1rem" }}>
    <h2>本社テスト用アカウントの削除</h2>
    <p>対象：{user?.name}（{user?.email}）</p>
    <p>このテスト環境の自分のログイン用アカウント、認証情報、GLabを含むサービスの登録情報を削除します。元に戻せません。</p>
    <p>別のサービスが独自に保存した投稿などは対象外です。組織の所有者は削除できません。</p>
    <p>削除後はログアウトします。登録画面を試すには、新しいアカウントを登録してください。</p>
    <label>確認のため DELETE と入力してください
      <input value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} autoComplete="off" />
    </label>
    <button type="button" disabled={busy || confirmation !== "DELETE"} onClick={() => { void deleteAccount(); }}>
      {busy ? "削除中…" : "本人確認してアカウントを削除"}
    </button>
    {error && <p role="alert">{error}</p>}
  </section>;
}
