/**
 * 現地確認 MFA の kiosk 公開鍵レジストリ (admin)。
 * 公開鍵は Ostiarius の `GET /gateway-public-key` の値を運用者が貼り付けて登録する。
 * 失効した lanId は再登録で戻せない (新しい lanId で登録し直す)。
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { onsiteKioskApi, type OnsiteKioskView } from "../../lib/onsite-kiosk-api";

const card: React.CSSProperties = {
  padding: "1rem", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "6px",
};
const field: React.CSSProperties = { display: "block", width: "100%", boxSizing: "border-box", marginTop: "0.25rem" };
const EMPTY_FORM = { lanId: "", placeId: "", lanUrl: "", label: "", publicKeyPem: "" };

export function OnsiteKiosksPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [kiosks, setKiosks] = useState<OnsiteKioskView[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setKiosks(await onsiteKioskApi.list()); setError(""); }
    catch (err) { setError((err as Error).message); }
  }, []);

  useEffect(() => { if (isAdmin) void load(); }, [isAdmin, load]);

  if (user && !isAdmin) return <Navigate to="/" replace />;

  const register = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await onsiteKioskApi.register({ lanId: form.lanId.trim(), placeId: form.placeId.trim(), lanUrl: form.lanUrl.trim(),
        publicKeyPem: form.publicKeyPem.trim(), ...(form.label.trim() ? { label: form.label.trim() } : {}) });
      setForm(EMPTY_FORM);
      await load();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const revoke = async (lanId: string) => {
    if (!window.confirm(`kiosk ${lanId} を失効させます。同じ lanId では再登録できません。続けますか?`)) return;
    setBusy(true); setError("");
    try { await onsiteKioskApi.revoke(lanId); await load(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const input = (key: keyof typeof EMPTY_FORM, label: string, placeholder = "") => (
    <label style={{ display: "block", marginBottom: "0.5rem" }}>{label}
      <input style={field} value={form[key]} placeholder={placeholder} required={key !== "label"} disabled={busy}
        onChange={(event) => setForm((prev) => ({ ...prev, [key]: event.target.value }))} />
    </label>
  );

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <h2>現地確認 kiosk</h2>
      <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
        現地確認 MFA の attestation を署名する kiosk (Ostiarius) の Ed25519 公開鍵です。
        Ostiarius の <code>GET /gateway-public-key</code> の値を登録してください。
      </p>
      {error && <p role="alert" style={{ color: "var(--red, #f85149)" }}>{error}</p>}
      <form style={card} onSubmit={(event) => { void register(event); }}>
        {input("lanId", "lanId", "ostiarius-1f")}
        {input("placeId", "placeId (施設)")}
        {input("lanUrl", "LAN URL (https)", "https://kiosk.facility.lan:8443")}
        {input("label", "表示名 (任意)")}
        <label style={{ display: "block", marginBottom: "0.5rem" }}>公開鍵 (SPKI PEM)
          <textarea style={{ ...field, minHeight: "6rem", fontFamily: "monospace" }} value={form.publicKeyPem} required disabled={busy}
            onChange={(event) => setForm((prev) => ({ ...prev, publicKeyPem: event.target.value }))} />
        </label>
        <button type="submit" disabled={busy}>登録 / 更新</button>
      </form>
      <div style={card}>
        {kiosks.length === 0 ? <p>登録済みの kiosk はありません。</p> : (
          <table style={{ width: "100%", fontSize: "0.85rem" }}>
            <thead><tr><th>lanId</th><th>施設</th><th>LAN URL</th><th>表示名</th><th>状態</th><th /></tr></thead>
            <tbody>
              {kiosks.map((kiosk) => (
                <tr key={kiosk.lanId}>
                  <td>{kiosk.lanId}</td><td>{kiosk.placeId}</td><td>{kiosk.lanUrl}</td><td>{kiosk.label ?? ""}</td>
                  <td>{kiosk.status === "active" ? "有効" : `失効 (${kiosk.revokedAt ?? ""})`}</td>
                  <td>{kiosk.status === "active" && (
                    <button type="button" disabled={busy} onClick={() => { void revoke(kiosk.lanId); }}>失効</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
