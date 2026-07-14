import { useState, useEffect, useCallback } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { wsClient } from "../../lib/ws-client";
import { useIsMobile } from "../../hooks/useIsMobile";

/** server: server/src/oidc/clients.ts OidcClientPublic と一致。 */
interface OidcClient {
  id: string;
  clientId: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

interface SecretReveal {
  clientId: string;
  name: string;
  clientSecret: string;
  /** register 直後か rotate 直後か (表示文言の出し分け)。 */
  kind: "register" | "rotate";
}

/** server: server/src/auth/oidc-keys.ts OidcKeyStatus と一致。 */
interface OidcKeyStatus {
  enabled: boolean;
  activeKid: string | null;
  keys: Array<{ kid: string; current: boolean }>;
}

const ALL_SCOPES = ["openid", "email", "profile"] as const;

const card: React.CSSProperties = {
  padding: "1rem",
  background: "var(--bg-surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
};

const btn: React.CSSProperties = {
  padding: "0.3rem 0.75rem",
  fontSize: "0.8rem",
  borderRadius: "4px",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  cursor: "pointer",
};

const dangerBtn: React.CSSProperties = {
  ...btn,
  border: "1px solid var(--red, #f85149)",
  color: "var(--red, #f85149)",
};

export function OidcClientsPage() {
  const { user, wsConnected } = useAuth();
  const isAdmin = user?.role === "admin";
  const isMobile = useIsMobile();

  const [clients, setClients] = useState<OidcClient[]>([]);
  const [keyStatus, setKeyStatus] = useState<OidcKeyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<SecretReveal | null>(null);

  // 登録フォーム
  const [showRegister, setShowRegister] = useState(false);
  const [name, setName] = useState("");
  const [redirectText, setRedirectText] = useState("");
  const [scopes, setScopes] = useState<string[]>([...ALL_SCOPES]);

  // redirect_uri 編集 (clientId → テキスト)
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const fetchAll = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      if (!silent) setError(null);
      const [list, status] = await Promise.all([
        wsClient.sendCommand<OidcClient[]>("oidc_client", "list"),
        wsClient.sendCommand<OidcKeyStatus>("oidc_keys", "status").catch(() => null),
      ]);
      setClients((prev) => (JSON.stringify(prev) === JSON.stringify(list) ? prev : list));
      if (status) setKeyStatus((prev) => (JSON.stringify(prev) === JSON.stringify(status) ? prev : status));
    } catch (err) {
      if (!silent) setError((err as Error).message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!wsConnected || !isAdmin) return;
    fetchAll();
  }, [wsConnected, isAdmin, fetchAll]);

  // 非 admin はアクセス不可 (バックエンドも requireSystemAdmin で弾くが UI でも遮断)。
  if (user && !isAdmin) return <Navigate to="/" replace />;

  const parseRedirects = (text: string): string[] =>
    text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

  const toggleScope = (s: string) => {
    if (s === "openid") return; // openid は必須
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  const resetRegisterForm = () => {
    setName("");
    setRedirectText("");
    setScopes([...ALL_SCOPES]);
  };

  const handleRegister = async () => {
    setError(null);
    try {
      const redirectUris = parseRedirects(redirectText);
      if (!name.trim()) throw new Error("name is required");
      if (redirectUris.length === 0) throw new Error("at least one redirect_uri is required");
      const result = await wsClient.sendCommand<{ client: OidcClient; clientSecret: string }>(
        "oidc_client",
        "register",
        { name: name.trim(), redirectUris, scopes },
      );
      setSecret({
        clientId: result.client.clientId,
        name: result.client.name,
        clientSecret: result.clientSecret,
        kind: "register",
      });
      setShowRegister(false);
      resetRegisterForm();
      fetchAll();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleRotate = async (c: OidcClient) => {
    if (!confirm(`"${c.name}" の client_secret を再発行しますか？\n旧 secret を使う RP は接続できなくなります。`)) return;
    setError(null);
    try {
      const result = await wsClient.sendCommand<{ client: OidcClient; clientSecret: string }>(
        "oidc_client",
        "rotate_secret",
        { clientId: c.clientId },
      );
      setSecret({ clientId: c.clientId, name: c.name, clientSecret: result.clientSecret, kind: "rotate" });
      fetchAll();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleToggleActive = async (c: OidcClient) => {
    setError(null);
    try {
      await wsClient.sendCommand("oidc_client", c.isActive ? "disable" : "enable", { clientId: c.clientId });
      fetchAll();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const startEdit = (c: OidcClient) => {
    setEditing(c.clientId);
    setEditText(c.redirectUris.join("\n"));
    setError(null);
  };

  const handleSaveRedirects = async (clientId: string) => {
    setError(null);
    try {
      const redirectUris = parseRedirects(editText);
      await wsClient.sendCommand("oidc_client", "update_redirect_uris", { clientId, redirectUris });
      setEditing(null);
      fetchAll();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div style={{ height: "100%", width: "100%", overflow: "auto" }}>
      <div style={{ padding: isMobile ? "1rem" : "1.5rem", width: "100%", minWidth: 0, maxWidth: "1100px", margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <div>
            <h2 style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>OIDC クライアント</h2>
            <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.25rem" }}>
              Cernere を IdP とする Relying Party (Cloudflare Access 等) の登録・管理
            </div>
          </div>
          <button onClick={() => { setShowRegister(!showRegister); setError(null); }} style={btn}>
            {showRegister ? "Cancel" : "+ 登録"}
          </button>
        </div>

        {error && (
          <div style={{ padding: "0.5rem 0.75rem", marginBottom: "1rem", borderRadius: "4px", background: "rgba(248,81,73,0.1)", border: "1px solid var(--red, #f85149)", fontSize: "0.85rem", color: "var(--red)" }}>
            {error}
          </div>
        )}

        {/* secret reveal (1 度きり) */}
        {secret && (
          <div style={{ padding: "0.75rem", marginBottom: "1rem", borderRadius: "4px", background: "rgba(46,160,67,0.1)", border: "1px solid var(--green, #2ea043)", fontSize: "0.85rem" }}>
            <strong>
              {secret.kind === "register" ? `"${secret.name}" を登録しました` : `"${secret.name}" の secret を再発行しました`}
            </strong>
            <div style={{ marginTop: "0.5rem", fontFamily: "monospace", fontSize: "0.8rem", wordBreak: "break-all" }}>
              Client ID: {secret.clientId}<br />
              Client Secret: {secret.clientSecret}
            </div>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.5rem" }}>
              <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                secret はこの画面でしか表示されません。 今すぐ控えてください。
              </span>
              <button onClick={() => navigator.clipboard?.writeText(secret.clientSecret)} style={{ ...btn, fontSize: "0.7rem", padding: "0.15rem 0.5rem" }}>copy</button>
              <button onClick={() => setSecret(null)} style={{ ...btn, fontSize: "0.7rem", padding: "0.15rem 0.5rem" }}>閉じる</button>
            </div>
          </div>
        )}

        {/* 登録フォーム */}
        {showRegister && (
          <div style={{ ...card, marginBottom: "1.5rem" }}>
            <h3 style={{ fontSize: "0.9rem", fontWeight: 600, marginBottom: "0.75rem" }}>RP を登録</h3>
            <label style={{ display: "block", fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.3rem" }}>名前</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Cloudflare Access"
              style={{ width: "100%", padding: "0.4rem 0.5rem", fontSize: "0.85rem", borderRadius: "4px", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", boxSizing: "border-box", marginBottom: "0.75rem" }}
            />
            <label style={{ display: "block", fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.3rem" }}>
              Redirect URI (1 行 1 件、 完全一致)
            </label>
            <textarea
              value={redirectText}
              onChange={(e) => setRedirectText(e.target.value)}
              placeholder={"https://<team>.cloudflareaccess.com/cdn-cgi/access/callback"}
              style={{ width: "100%", minHeight: "80px", padding: "0.5rem", fontFamily: "monospace", fontSize: "0.8rem", borderRadius: "4px", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", boxSizing: "border-box", resize: "vertical", marginBottom: "0.75rem" }}
            />
            <label style={{ display: "block", fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.3rem" }}>Scopes</label>
            <div style={{ display: "flex", gap: "1rem", marginBottom: "0.75rem", flexWrap: "wrap" }}>
              {ALL_SCOPES.map((s) => (
                <label key={s} style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.8rem", color: s === "openid" ? "var(--text-muted)" : "var(--text)" }}>
                  <input type="checkbox" checked={scopes.includes(s)} disabled={s === "openid"} onChange={() => toggleScope(s)} />
                  {s}{s === "openid" ? " (必須)" : ""}
                </label>
              ))}
            </div>
            <button className="primary" onClick={handleRegister}>登録</button>
          </div>
        )}

        {/* JWKS 鍵ステータス (#208) */}
        {keyStatus && (
          <div style={{ ...card, marginBottom: "1.5rem" }}>
            <h3 style={{ fontSize: "0.9rem", fontWeight: 600, marginBottom: "0.5rem" }}>署名鍵 (JWKS)</h3>
            {!keyStatus.enabled ? (
              <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", margin: 0 }}>
                OIDC は無効です (<code>CERNERE_OIDC_PRIVATE_KEY</code> 未設定)。
              </p>
            ) : (
              <>
                <div style={{ fontSize: "0.8rem", marginBottom: "0.5rem" }}>
                  現行署名鍵: <code>{keyStatus.activeKid}</code>
                </div>
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  {keyStatus.keys.map((k) => (
                    <span key={k.kid} title={k.current ? "新規 id_token を署名している現行鍵" : "検証専用の旧鍵 (ローテーション中)"} style={{
                      fontSize: "0.7rem", padding: "0.15rem 0.5rem", borderRadius: "3px",
                      border: "1px solid var(--border)",
                      background: k.current ? "var(--green, #2ea043)" : "transparent",
                      color: k.current ? "#fff" : "var(--text-muted)",
                    }}>
                      {k.kid}{k.current ? " (current)" : " (previous)"}
                    </span>
                  ))}
                </div>
                <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: "0.5rem" }}>
                  鍵ローテーション手順は <code>spec/setup/oidc-provider.md §5</code>。 鍵は env / Infisical で管理します。
                </div>
              </>
            )}
          </div>
        )}

        {/* クライアント一覧 */}
        {loading ? (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Loading...</p>
        ) : clients.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>RP は未登録です。「+ 登録」から追加してください。</p>
        ) : (
          <div style={{ display: "grid", gap: "0.75rem" }}>
            {clients.map((c) => (
              <div key={c.clientId} style={card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.5rem", flexWrap: "wrap" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <span style={{ fontSize: "0.95rem", fontWeight: 600 }}>{c.name}</span>
                      <span style={{
                        fontSize: "0.65rem", padding: "0.1rem 0.4rem", borderRadius: "2px",
                        background: c.isActive ? "var(--green, #2ea043)" : "var(--red, #f85149)", color: "#fff",
                      }}>{c.isActive ? "active" : "disabled"}</span>
                    </div>
                    <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.25rem", fontFamily: "monospace", wordBreak: "break-all" }}>
                      {c.clientId}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "0.4rem", flexShrink: 0, flexWrap: "wrap" }}>
                    <button onClick={() => startEdit(c)} style={btn}>redirect 編集</button>
                    <button onClick={() => handleRotate(c)} style={btn}>secret 再発行</button>
                    <button onClick={() => handleToggleActive(c)} style={c.isActive ? dangerBtn : btn}>
                      {c.isActive ? "無効化" : "有効化"}
                    </button>
                  </div>
                </div>

                <div style={{ marginTop: "0.6rem", fontSize: "0.78rem" }}>
                  <div style={{ color: "var(--text-muted)", marginBottom: "0.2rem" }}>Scopes: {c.scopes.join(" ")}</div>
                  {editing === c.clientId ? (
                    <div style={{ marginTop: "0.4rem" }}>
                      <textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        style={{ width: "100%", minHeight: "70px", padding: "0.4rem", fontFamily: "monospace", fontSize: "0.78rem", borderRadius: "4px", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", boxSizing: "border-box", resize: "vertical" }}
                      />
                      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.4rem" }}>
                        <button className="primary" onClick={() => handleSaveRedirects(c.clientId)}>保存</button>
                        <button onClick={() => setEditing(null)} style={btn}>キャンセル</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ color: "var(--text-muted)" }}>
                      Redirect URIs:
                      <ul style={{ margin: "0.2rem 0 0", paddingLeft: "1.1rem", fontFamily: "monospace", wordBreak: "break-all" }}>
                        {c.redirectUris.map((u) => <li key={u}>{u}</li>)}
                      </ul>
                    </div>
                  )}
                </div>

                <div style={{ marginTop: "0.5rem", fontSize: "0.7rem", color: "var(--text-muted)" }}>
                  登録: {new Date(c.createdAt).toLocaleString()}
                  {c.lastUsedAt && <> &middot; 最終利用: {new Date(c.lastUsedAt).toLocaleString()}</>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
