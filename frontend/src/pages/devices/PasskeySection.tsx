import { useState, useEffect, useCallback } from "react";
import { auth as authApi } from "../../lib/api";

/** パスキーの一覧・追加・削除。「端末とログイン」に置く (旧: プロフィール)。 */

interface PasskeyEntry {
  id: string;
  credentialId: string;
  nickname: string | null;
  deviceType: string;
  backedUp: boolean;
  aaguid: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export function PasskeySection() {
  const [items, setItems] = useState<PasskeyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState("");

  const refresh = useCallback(async () => {
    try {
      const r = await authApi.passkeyList();
      setItems(r.items);
    } catch (e) {
      console.error("[passkey] list failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleAdd = async () => {
    setAdding(true); setMsg("");
    try {
      const nickname = window.prompt("このパスキーのニックネーム (例: iPhone 15 / Yubikey 5C)") ?? "";
      await authApi.passkeyRegister(nickname || undefined);
      setMsg("✓ パスキーを登録しました");
      await refresh();
    } catch (e) {
      setMsg(`⚠ ${(e as Error).message}`);
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (entry: PasskeyEntry) => {
    if (!window.confirm(`「${entry.nickname || entry.credentialId.slice(0, 12)}…」 を削除しますか?`)) return;
    try {
      await authApi.passkeyDelete(entry.id);
      await refresh();
    } catch (e) {
      setMsg(`⚠ 削除失敗: ${(e as Error).message}`);
    }
  };

  return (
    <div
      style={{
        background: "var(--bg-surface-2)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "1.5rem",
        marginTop: "1rem",
      }}
    >
      <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.5rem", color: "var(--text-muted)" }}>
        🔐 パスキー (WebAuthn)
      </h2>
      <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.7, marginBottom: "0.75rem" }}>
        Face ID / Touch ID / Windows Hello / Android 生体認証 / 物理セキュリティキー (YubiKey 等) で
        パスワードなしログインできます。 端末ごとに 1 件追加してください。
      </p>
      {msg && <div style={{ fontSize: "0.8rem", margin: "0.5rem 0", color: msg.startsWith("⚠") ? "var(--red)" : "var(--green)" }}>{msg}</div>}
      <button
        type="button"
        onClick={handleAdd}
        disabled={adding}
        style={{
          fontSize: "0.85rem",
          padding: "0.4rem 1rem",
          borderRadius: "var(--radius)",
          border: "1px solid var(--accent)",
          background: "var(--accent)",
          color: "#fff",
          cursor: adding ? "not-allowed" : "pointer",
          marginBottom: "0.75rem",
        }}
      >
        {adding ? "登録中…" : "+ パスキーを追加"}
      </button>
      {loading ? (
        <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>読み込み中…</p>
      ) : items.length === 0 ? (
        <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>まだ登録されたパスキーはありません。</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {items.map((it) => (
            <li
              key={it.id}
              style={{
                display: "flex", alignItems: "center", gap: "0.75rem",
                padding: "0.5rem 0",
                borderBottom: "1px solid var(--border)",
                fontSize: "0.85rem",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {it.nickname || `passkey ${it.credentialId.slice(0, 8)}…`}
                  {it.backedUp && <span style={{ marginLeft: 8, fontSize: "0.7rem", color: "var(--green)" }}>同期</span>}
                  {it.deviceType === "singleDevice" && <span style={{ marginLeft: 8, fontSize: "0.7rem", color: "var(--text-muted)" }}>端末固定</span>}
                </div>
                <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                  追加 {new Date(it.createdAt).toLocaleString()}
                  {it.lastUsedAt && ` · 最終使用 ${new Date(it.lastUsedAt).toLocaleString()}`}
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleDelete(it)}
                style={{
                  fontSize: "0.75rem",
                  padding: "0.25rem 0.6rem",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--red)",
                  background: "transparent",
                  color: "var(--red)",
                  cursor: "pointer",
                }}
              >
                削除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
