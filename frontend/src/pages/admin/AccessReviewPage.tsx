/**
 * 利用許可の審査 (admin、許可制 案 A)。
 *
 * 申請の詳細表示と決定は分けて、決定ごとにこの端末のパスキーで確かめる (user_access.decide)。
 * 申請本文はリンクを含んでいても開かない (テキストとして表示するだけ)。表示名や申請本文だけで
 * 本人と判断せず、別の連絡手段で確かめてから許可する。
 */

import { useCallback, useEffect, useState } from "react";
import { bodyTextStyle, messageStyle, pageStyle, panelStyle, primaryButton, secondaryButton } from "../../components/security/panel-styles";
import { useAuth } from "../../contexts/AuthContext";
import { userAccess, type AccessDecision, type AccessReviewItem, type AccessStatus } from "../../lib/user-access-api";

type Tab = "requests" | AccessStatus;

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "requests", label: "審査待ち" },
  { id: "pending", label: "許可待ち (未申請を含む)" },
  { id: "active", label: "許可済み" },
  { id: "locked", label: "停止中" },
];

const ACTIONS: Record<AccessStatus, Array<{ decision: AccessDecision; label: string; reason: string }>> = {
  pending: [
    { decision: "approve", label: "許可する", reason: "verified_out_of_band" },
    { decision: "reject", label: "拒否する", reason: "not_verified" },
  ],
  active: [{ decision: "lock", label: "停止する", reason: "admin_lock" }],
  locked: [{ decision: "unlock", label: "停止を解除する", reason: "admin_unlock" }],
};

export function AccessReviewPage() {
  const { user, wsConnected } = useAuth();
  const [tab, setTab] = useState<Tab>("requests");
  const [items, setItems] = useState<AccessReviewItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const load = useCallback(async () => setItems(await userAccess.list(tab)), [tab]);
  useEffect(() => { if (wsConnected) void load().catch((e) => setError((e as Error).message)); }, [wsConnected, load]);

  const decide = async (item: AccessReviewItem, decision: AccessDecision, reason: string) => {
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const result = await userAccess.decide(item, decision, reason);
      setInfo(`${item.displayName || item.userId.slice(0, 8)}: ${result.status} にしました。`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (user?.role !== "admin") return <main style={pageStyle}><p style={bodyTextStyle}>管理者だけが使えます。</p></main>;

  return (
    <main style={{ ...pageStyle, maxWidth: "48rem" }}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700 }}>利用許可の審査</h1>
      <p style={bodyTextStyle}>
        表示名や申請本文だけで本人と判断せず、別の連絡手段で確かめてから許可してください。決定のたびにこの端末のパスキーで確認します。
      </p>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)} style={t.id === tab ? primaryButton(false) : secondaryButton(false)}>{t.label}</button>
        ))}
      </div>
      {error && <div role="alert" style={messageStyle(true)}>{error}</div>}
      {info && <div style={messageStyle(false)}>{info}</div>}
      {items.length === 0 && <p style={bodyTextStyle}>該当するアカウントはありません。</p>}
      {items.map((item) => (
        <div key={item.userId} style={panelStyle}>
          <div style={{ fontWeight: 600 }}>{item.displayName || "(名前未設定)"}</div>
          <div style={{ ...bodyTextStyle, fontFamily: "monospace", marginBottom: "0.25rem" }}>{item.userId}</div>
          <div style={bodyTextStyle}>登録: {new Date(item.createdAt).toLocaleString()} / 状態: {item.status}</div>
          {item.request && (
            <div style={{ ...bodyTextStyle, whiteSpace: "pre-wrap", color: "var(--text)", borderLeft: "3px solid var(--border)", paddingLeft: "0.75rem" }}>
              {item.request.purpose}
              <div style={{ color: "var(--text-muted)" }}>申請: {new Date(item.request.createdAt).toLocaleString()}</div>
            </div>
          )}
          <div style={{ display: "flex", gap: "0.5rem" }}>
            {ACTIONS[item.status].map((a) => (
              <button key={a.decision} type="button" disabled={busy || item.userId === user.id}
                style={a.decision === "approve" || a.decision === "unlock" ? primaryButton(busy) : secondaryButton(busy)}
                onClick={() => { void decide(item, a.decision, a.reason); }}>
                {a.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </main>
  );
}
