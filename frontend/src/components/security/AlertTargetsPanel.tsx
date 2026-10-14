/**
 * ログイン通知の宛先 (SPEC-LOGIN-ALERT)。
 *
 * Discord / Google のアカウント連携済みの宛先にだけ設定できる。追加すると試験通知で
 * 6 桁の確認番号が届き、それを入力した宛先だけに通知する。追加・削除はこの端末の
 * パスキーで確かめる (WS 層が login_alert.manage の proof を取る)。
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { wsClient } from "../../lib/ws-client";
import {
  bodyTextStyle, inputStyle, messageStyle, panelStyle, panelTitleStyle, primaryButton, secondaryButton,
} from "./panel-styles";

type Channel = "discord" | "google";

interface TargetsView {
  targets: Array<{ channel: Channel; verified: boolean; degraded: boolean }>;
  linked: Record<Channel, boolean>;
}

const LABEL: Record<Channel, string> = { discord: "Discord (DM)", google: "Google (確認済みメール)" };

export function AlertTargetsPanel() {
  const { wsConnected } = useAuth();
  const [view, setView] = useState<TargetsView | null>(null);
  const [codes, setCodes] = useState<Record<Channel, string>>({ discord: "", google: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const load = useCallback(async () => {
    setView(await wsClient.sendCommand<TargetsView>("login_alert", "list", {}));
  }, []);
  useEffect(() => { if (wsConnected) void load().catch((e) => setError((e as Error).message)); }, [wsConnected, load]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError("");
    setInfo("");
    try {
      await fn();
      setInfo(done);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={panelStyle}>
      <h2 style={panelTitleStyle}>🔔 ログイン通知</h2>
      <p style={bodyTextStyle}>
        新しいログイン、パスキーの追加、リカバリー QR の使用などを知らせます。宛先は連携済みの Discord か Google から選べます。
        Cernere はログインリンクを送らず、DM やメールでパスキーや QR を尋ねることはありません。
      </p>
      {error && <div role="alert" style={messageStyle(true)}>{error}</div>}
      {info && <div style={messageStyle(false)}>{info}</div>}
      {!view && <p style={bodyTextStyle}>読み込み中…</p>}
      {view && (["discord", "google"] as const).map((channel) => {
        const target = view.targets.find((t) => t.channel === channel);
        return (
          <div key={channel} style={{ borderTop: "1px solid var(--border)", paddingTop: "0.75rem", marginTop: "0.75rem" }}>
            <strong>{LABEL[channel]}</strong>
            {!view.linked[channel] && <p style={bodyTextStyle}>未連携です。プロフィールの「連携アカウント」から連携すると設定できます。</p>}
            {view.linked[channel] && !target && (
              <div style={{ marginTop: "0.5rem" }}>
                <button type="button" disabled={busy} style={primaryButton(busy)}
                  onClick={() => { void run(() => wsClient.sendCommand("login_alert", "start", { channel }), "確認番号を送りました。届いた 6 桁を入力してください。"); }}>
                  この宛先に通知する
                </button>
              </div>
            )}
            {target && !target.verified && (
              <div style={{ marginTop: "0.5rem" }}>
                <p style={bodyTextStyle}>届いた 6 桁の確認番号を入力してください (10 分で無効になります)。</p>
                <input inputMode="numeric" maxLength={6} value={codes[channel]} placeholder="000000"
                  onChange={(e) => setCodes({ ...codes, [channel]: e.target.value.replace(/\D/g, "") })}
                  style={{ ...inputStyle, maxWidth: "10rem", fontFamily: "monospace", letterSpacing: "0.2em" }} />
                <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                  <button type="button" disabled={busy || codes[channel].length !== 6} style={primaryButton(busy || codes[channel].length !== 6)}
                    onClick={() => { void run(() => wsClient.sendCommand("login_alert", "verify", { channel, code: codes[channel] }), "通知を有効にしました。"); }}>
                    確認する
                  </button>
                  <button type="button" disabled={busy} style={secondaryButton(busy)}
                    onClick={() => { void run(() => wsClient.sendCommand("login_alert", "start", { channel }), "確認番号を送り直しました。"); }}>
                    送り直す
                  </button>
                </div>
              </div>
            )}
            {target?.verified && (
              <div style={{ marginTop: "0.5rem" }}>
                <p style={bodyTextStyle}>
                  {target.degraded ? "⚠ 最近の通知が届いていません (Discord の DM 設定や共通サーバーへの参加を確かめてください)。" : "✓ 通知が届きます。"}
                </p>
                <button type="button" disabled={busy} style={secondaryButton(busy)}
                  onClick={() => { void run(() => wsClient.sendCommand("login_alert", "remove", { channel }), "通知の宛先を外しました。"); }}>
                  この宛先への通知をやめる
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
