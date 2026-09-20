/** Cloudflare enterprise connection administration. @implements SPEC-ENTERPRISE-ADMIN */
import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { wsClient } from "../../lib/ws-client";
import { ConnectionForm } from "./enterprise/ConnectionForm";
import { IdentityForm } from "./enterprise/IdentityForm";
import type { EnterpriseConfiguration } from "./enterprise/types";

export function EnterpriseConnectionsPage() {
  const { user, wsConnected } = useAuth();
  const [configuration, setConfiguration] = useState<EnterpriseConfiguration | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const isAdmin = user?.role === "admin";
  const reload = useCallback(async () => {
    const result = await wsClient.sendCommand<EnterpriseConfiguration>("enterprise", "list");
    setConfiguration(result);
  }, []);
  useEffect(() => {
    if (!wsConnected || !isAdmin) return;
    void reload().catch((e: unknown) => setError(e instanceof Error ? e.message : "読み込みに失敗しました"));
  }, [wsConnected, isAdmin, reload]);
  const save = async (action: string, payload: Record<string, unknown>): Promise<void> => {
    setBusy(true); setError(""); setNotice("");
    try {
      await wsClient.sendCommand("enterprise", action, payload);
      setNotice("保存しました。変更前の企業セッションは利用できません。");
      setSelected(String(payload.projectKey));
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : "保存に失敗しました"); }
    finally { setBusy(false); }
  };
  if (user && !isAdmin) return <Navigate to="/" replace />;
  const connection = configuration?.connections.find((item) => item.projectKey === selected);
  return <main style={{ padding: "1.5rem", width: "100%", maxWidth: "1000px", margin: "0 auto", overflow: "auto", boxSizing: "border-box" }}>
    <h2>Cloudflare 企業認証</h2>
    <p>Cr で本人確認と MFA を行い、Cloudflare Access で企業アプリへの入口を制御します。企業セッションの権限は選択した組織とプロジェクトに限定されます。</p>
    {error && <p role="alert" style={{ color: "var(--red)" }}>{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!wsConnected && <p role="status">接続待ちです。</p>}
    <button disabled={busy || !wsConnected} onClick={() => void reload().catch((e: unknown) => setError(e instanceof Error ? e.message : "読み込みに失敗しました"))}>一覧を再読み込み</button>
    {configuration && <>
      <label style={{ display: "block", margin: "1rem 0" }}>接続 <select disabled={busy} value={selected} onChange={(e) => { setSelected(e.target.value); setNotice(""); }}>
        <option value="">新規登録</option>
        {configuration.connections.map((item) => <option key={item.projectKey} value={item.projectKey}>{item.projectKey} — {item.isActive ? "有効" : "無効"}</option>)}
      </select></label>
      <ConnectionForm key={connection?.revision ?? "new"} connection={connection} configuration={configuration} busy={busy || !wsConnected} save={save} />
      {connection && <IdentityForm key={connection.revision} connection={connection} configuration={configuration} busy={busy || !wsConnected} save={save} />}
    </>}
  </main>;
}
