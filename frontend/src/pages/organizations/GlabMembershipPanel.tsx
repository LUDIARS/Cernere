import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { wsClient } from "../../lib/ws-client";
import { bodyTextStyle, messageStyle, panelStyle, panelTitleStyle } from "../../components/security/panel-styles";
import { discrepancyLabel, githubStateLabel, rowActions, statusLabel, type GlabMemberView, type GlabRowAction } from "./glab-membership-view";

interface ListResult { organizationId: string; githubConfigured: boolean; members: GlabMemberView[] }
interface Discrepancy { kind: string; userId: string | null; displayName: string | null; githubLogin: string | null }

/**
 * 組織画面の GLab 在籍パネル (spec/feature/glab-membership-github.md)。
 * 選んだ組織が Cernere に設定された GLab 組織で、自分がリーダー以上のときだけ出る (それ以外は server が 403/503)。
 */
export function GlabMembershipPanel({ organizationId }: { organizationId: string }) {
  const { user, wsConnected } = useAuth();
  const [data, setData] = useState<ListResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [discrepancies, setDiscrepancies] = useState<Discrepancy[] | null>(null);

  const load = useCallback(async () => {
    try { setData(await wsClient.sendCommand<ListResult>("glab_membership", "list")); }
    catch { setData(null); }
  }, []);
  useEffect(() => { if (wsConnected) void load(); }, [wsConnected, load, organizationId]);

  if (!data || data.organizationId !== organizationId) return null;

  const run = async (action: GlabRowAction | "reconcile" | "apply_org_settings", userId?: string) => {
    setBusy(true); setError("");
    try {
      const result = await wsClient.sendCommand<{ discrepancies?: Discrepancy[] }>("glab_membership", action, userId ? { userId } : {});
      if (action === "reconcile") setDiscrepancies(result.discrepancies ?? []);
      else await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...panelStyle, marginTop: "1.5rem" }}>
      <h3 style={panelTitleStyle}>GLab の在籍と GitHub</h3>
      <p style={bodyTextStyle}>
        入会と OB への切り替えを記録し、GitHub の在校生チーム・OB チームに反映します。本人は自分の区分を変えられません。
        {!data.githubConfigured && " GitHub 連携は未設定のため、記録だけを行います。"}
      </p>
      {error && <div role="alert" style={messageStyle(true)}>{error}</div>}
      <table style={{ width: "100%", fontSize: "0.8rem", borderCollapse: "collapse" }}>
        <thead><tr><th align="left">名前</th><th align="left">区分</th><th align="left">GitHub</th><th /></tr></thead>
        <tbody>
          {data.members.map((m) => (
            <tr key={m.userId} style={{ borderTop: "1px solid var(--border)" }}>
              <td>{m.displayName || m.userId.slice(0, 8)}</td>
              <td>
                {statusLabel(m.status)}
                {m.joinedAt && <div style={{ color: "var(--text-muted)" }}>入会 {new Date(m.joinedAt).toLocaleDateString()}</div>}
                {m.alumniAt && <div style={{ color: "var(--text-muted)" }}>OB {new Date(m.alumniAt).toLocaleDateString()}</div>}
              </td>
              <td>{githubStateLabel(m)}</td>
              <td style={{ textAlign: "right" }}>
                {rowActions(m, user?.id).map((a) => (
                  <button key={a.action} type="button" disabled={busy} onClick={() => { void run(a.action, m.userId); }} style={{ marginLeft: "0.25rem" }}>{a.label}</button>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.githubConfigured && (
        <div style={{ marginTop: "1rem" }}>
          <button type="button" disabled={busy} onClick={() => { void run("reconcile"); }}>GitHub と照合する</button>
          {user?.role === "admin" && (
            <button type="button" disabled={busy} onClick={() => { void run("apply_org_settings"); }} style={{ marginLeft: "0.5rem" }}>組織の設定を反映 (private のみ)</button>
          )}
        </div>
      )}
      {discrepancies && (
        <div style={{ marginTop: "0.75rem" }}>
          {discrepancies.length === 0 ? <p style={bodyTextStyle}>食い違いはありません。</p> : (
            <ul style={{ ...bodyTextStyle, paddingLeft: "1.25rem" }}>
              {discrepancies.map((d, i) => (
                <li key={`${d.kind}-${d.userId ?? d.githubLogin}-${i}`}>
                  {discrepancyLabel(d.kind)}: {d.displayName ?? ""}{d.githubLogin ? ` (@${d.githubLogin})` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
