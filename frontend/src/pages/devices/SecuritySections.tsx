/**
 * 「端末とログイン」の安全まわりの部品 (SPEC-LOGIN-ALERT の「心当たりがない」入口)。
 *
 * - RecoveryPanels: 保留中のリカバリー QR 回復の取消と、リカバリー QR の作り直し。
 * - SecurityEventsPanel: 最近の出来事。全端末ログアウトではパスキーは消えないので、
 *   心当たりの無いパスキーは同じ画面のパスキー一覧から削除するよう案内する。
 */

import { useCallback, useEffect, useState } from "react";
import { RecoveryCodePanel } from "../../components/security/RecoveryCodePanel";
import { bodyTextStyle, messageStyle, panelStyle, panelTitleStyle, primaryButton } from "../../components/security/panel-styles";
import { useAuth } from "../../contexts/AuthContext";
import { recoveryCode, type RecoveryStatus } from "../../lib/passkey-account-api";
import { wsClient } from "../../lib/ws-client";

interface SecurityEvent {
  id: string;
  kind: string;
  severity: "normal" | "high" | "critical";
  detail: { device?: string; channel?: string; eligibleAt?: string };
  createdAt: string;
}

const EVENT_LABEL: Record<string, string> = {
  "session.new": "新しいログイン",
  "passkey.pairing_requested": "別の端末からパスキー追加の要求",
  "passkey.added": "パスキーの追加",
  "passkey.removed": "パスキーの削除",
  "recovery.requested": "リカバリー QR の使用 (回復待機の開始)",
  "recovery.cancelled": "回復の取り消し",
  "recovery.completed": "リカバリー QR による回復の完了",
  "recovery.code_reissued": "リカバリー QR の作り直し",
  "recovery.operator": "運用者による回復",
  "session.revoke_all": "すべての端末からログアウト",
  "alert_target.added": "通知の宛先の追加",
  "alert_target.removed": "通知の宛先の削除",
  "federation.joined": "新しい端末の連携",
  "federation.left": "連携から端末を外した",
  "federation.primary_changed": "連携の主の切り替え",
};

export function RecoveryPanels() {
  const [recovery, setRecovery] = useState<RecoveryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const loadRecovery = useCallback(async () => setRecovery(await recoveryCode.status()), []);
  useEffect(() => { void loadRecovery().catch((e) => setError((e as Error).message)); }, [loadRecovery]);

  const cancelRecovery = async () => {
    if (!recovery?.pendingRecovery) return;
    setBusy(true);
    setError("");
    try {
      await recoveryCode.cancel(recovery.pendingRecovery.requestId);
      setInfo("回復を取り消しました。使われたリカバリー QR は無効にしました。下で新しい QR を作ってください。");
      await loadRecovery();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && <div role="alert" style={messageStyle(true)}>{error}</div>}
      {info && <div style={messageStyle(false)}>{info}</div>}
      {recovery?.pendingRecovery && (
        <div style={{ ...panelStyle, borderColor: "var(--red)" }}>
          <h2 style={{ ...panelTitleStyle, color: "var(--red)" }}>⚠ リカバリー QR による回復が進行中です</h2>
          <p style={bodyTextStyle}>
            {new Date(recovery.pendingRecovery.createdAt).toLocaleString()} に
            {recovery.pendingRecovery.device ? ` ${recovery.pendingRecovery.device} から` : ""}始まりました。
            <strong>{new Date(recovery.pendingRecovery.eligibleAt).toLocaleString()}</strong> を過ぎると、この端末を含むすべてのパスキーが使えなくなります。
            心当たりがなければ、すぐに取り消してください。
          </p>
          <button type="button" onClick={() => { void cancelRecovery(); }} disabled={busy} style={primaryButton(busy)}>回復を取り消す</button>
        </div>
      )}
      {recovery && (
        <RecoveryCodePanel withoutProof={recovery.canIssueWithoutProof} hasActiveCode={recovery.hasActiveCode} onSaved={() => { void loadRecovery(); }} />
      )}
    </>
  );
}

export function SecurityEventsPanel() {
  const { wsConnected } = useAuth();
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [error, setError] = useState("");

  const loadEvents = useCallback(async () => {
    const data = await wsClient.sendCommand<{ events: SecurityEvent[] }>("security_event", "list", {});
    setEvents(data.events);
  }, []);
  useEffect(() => { if (wsConnected) void loadEvents().catch((e) => setError((e as Error).message)); }, [wsConnected, loadEvents]);

  return (
    <div style={panelStyle}>
      <h2 style={panelTitleStyle}>最近の出来事</h2>
      <p style={bodyTextStyle}>
        心当たりのないものがあれば、この画面の「ログイン中の端末」から該当する端末を失効させ、
        パスキーの一覧から覚えのないパスキーを削除してください (全端末ログアウトだけではパスキーは消えません)。
      </p>
      {error && <div role="alert" style={messageStyle(true)}>{error}</div>}
      {events.length === 0 && !error && <p style={bodyTextStyle}>まだありません。</p>}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {events.map((event) => (
          <li key={event.id} style={{ borderTop: "1px solid var(--border)", padding: "0.5rem 0", fontSize: "0.85rem" }}>
            <span style={{ color: event.severity === "critical" ? "var(--red)" : "var(--text)" }}>
              {EVENT_LABEL[event.kind] ?? event.kind}
            </span>
            <span style={{ color: "var(--text-muted)" }}>
              {" "}— {new Date(event.createdAt).toLocaleString()}{event.detail.device ? ` / ${event.detail.device}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
