import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { wsClient } from "../lib/ws-client";

interface Device { deviceId: string; clientKind: string; createdAt: string; lastUsedAt: string; expiresAt: string }

export function DeviceSessionsPage() {
  const { wsConnected, logout } = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [currentDeviceId, setCurrentDeviceId] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const data = await wsClient.sendCommand<{ enabled: boolean; currentDeviceId?: string; devices: Device[] }>("device_session", "list", {});
    setEnabled(data.enabled);
    setCurrentDeviceId(data.currentDeviceId);
    setDevices(data.devices);
  }, []);
  useEffect(() => { if (wsConnected) void load().catch(e => setError(String(e))); }, [wsConnected, load]);
  async function revoke(deviceId?: string) {
    setBusy(true); setError("");
    try {
      await wsClient.sendCommand("device_session", deviceId ? "revoke" : "revoke_all", deviceId ? { deviceId } : {});
      // ここまで来れば失効は成立している。 後続の logout が失敗しても
      // 「失効に失敗」 とは表示しない (実際には失効済みで、 再試行させると誤解を招く)。
      if (!deviceId || deviceId === currentDeviceId) await logout().catch(() => {});
      else await load();
    } catch (e) { setError(e instanceof Error ? e.message : "端末の失効に失敗しました。"); }
    finally { setBusy(false); }
  }
  return <section>
    <h1>ログイン中の端末</h1>
    <p>パスキーでログインを保持しているブラウザです。端末を失効してもパスキーは削除されません。</p>
    {error && <p role="alert">{error}</p>}
    {!enabled && <p>端末のログイン保持は現在有効になっていません。通常のログインは引き続き利用できます。</p>}
    {!wsConnected && <p role="status">接続しています…</p>}
    {devices.length === 0 && wsConnected && <p>保持中の端末セッションはありません。</p>}
    <ul>{devices.map((device, index) => <li key={device.deviceId} style={{ marginBottom: "1rem" }}>
      <strong>{device.clientKind === "browser" ? "ブラウザ" : "アプリ"} {index + 1}{device.deviceId === currentDeviceId ? "（使用中）" : ""}</strong>
      <p>登録: {new Date(device.createdAt).toLocaleString()} / 最終利用: {new Date(device.lastUsedAt).toLocaleString()}</p>
      <p>有効期限: {new Date(device.expiresAt).toLocaleString()}</p>
      <button disabled={busy || !wsConnected} onClick={() => void revoke(device.deviceId)}>この端末を失効</button>
    </li>)}</ul>
    <p>全端末からログアウトすると、通常のログインや企業 SSO も再認証が必要になります。</p>
    <button disabled={busy || !wsConnected} onClick={() => void revoke()}>再認証して全端末からログアウト</button>
  </section>;
}
