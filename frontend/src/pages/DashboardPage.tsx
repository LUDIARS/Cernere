import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../contexts/AuthContext";
import { wsClient } from "../lib/ws-client";
import { useIsMobile } from "../hooks/useIsMobile";

interface ManagedProject {
  key: string;
  name: string;
  description: string;
  isActive: boolean;
  createdAt: string;
  /** 現在 project_credentials で繋いでいる接続数 */
  connectionCount: number;
  /** 直近接続タイムスタンプ (ISO) */
  lastConnectedAt: string | null;
}

interface ProjectDetail {
  key: string;
  name: string;
  description: string;
  clientId: string;
  schemaDefinition: {
    project: { key: string; name: string; description?: string };
    user_data?: { columns: Record<string, { type: string; nullable?: boolean; description?: string }> };
  };
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RegisterResult {
  message: string;
  key: string;
  clientId: string;
  clientSecret: string;
}

interface UserProjectOverview {
  key: string;
  name: string;
  description: string;
  isActive: boolean;
  totalColumns: number;
  filledColumns: number;
  inUse: boolean;
  connectionCount: number;
  lastConnectedAt: string | null;
}

export function DashboardPage() {
  const { user, wsConnected } = useAuth();
  const isAdmin = user?.role === "admin";
  const isMobile = useIsMobile();

  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [overviews, setOverviews] = useState<Record<string, UserProjectOverview>>({});
  const [selected, setSelected] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Admin: register form
  const [showRegister, setShowRegister] = useState(false);
  const [jsonInput, setJsonInput] = useState("");
  const [registerResult, setRegisterResult] = useState<RegisterResult | null>(null);
  const [templates, setTemplates] = useState<Array<{ key: string; name: string; description: string }>>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);

  // Fetch projects + user data overview (利用中/未使用 判定)
  const fetchProjects = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [list, ov] = await Promise.all([
        wsClient.sendCommand<ManagedProject[]>("managed_project", "list"),
        wsClient.sendCommand<UserProjectOverview[]>("managed_project", "overview")
          .catch(() => [] as UserProjectOverview[]),
      ]);
      setProjects(list);
      const map: Record<string, UserProjectOverview> = {};
      for (const o of ov) map[o.key] = o;
      setOverviews(map);
    } catch (err) {
      console.error("[Dashboard] Failed to fetch projects:", err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!wsConnected) return;
    fetchProjects();
    // 接続状況 (使用中バッジ) を 10 秒間隔で更新
    const id = window.setInterval(() => { fetchProjects(); }, 10_000);
    return () => { window.clearInterval(id); };
  }, [wsConnected, fetchProjects]);

  const selectProject = async (key: string) => {
    try {
      setError(null);
      const detail = await wsClient.sendCommand<ProjectDetail>("managed_project", "get", { key });
      setSelected(detail);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // テンプレート一覧を取得
  const fetchTemplates = useCallback(async () => {
    try {
      setLoadingTemplates(true);
      const result = await wsClient.sendCommand<Array<{ key: string; name: string; description: string }>>("managed_project", "templates");
      setTemplates(result);
    } catch (err) {
      console.error("[Dashboard] Failed to fetch templates:", err);
    } finally {
      setLoadingTemplates(false);
    }
  }, []);

  // テンプレート選択 → JSON をテキストエリアにコピー
  const selectTemplate = async (key: string) => {
    try {
      const def = await wsClient.sendCommand<unknown>("managed_project", "get_template", { key });
      setJsonInput(JSON.stringify(def, null, 2));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // 登録フォーム開閉時にテンプレートも取得
  useEffect(() => {
    if (showRegister && wsConnected) fetchTemplates();
  }, [showRegister, wsConnected, fetchTemplates]);

  const handleRegister = async () => {
    setError(null);
    setRegisterResult(null);
    try {
      const payload = JSON.parse(jsonInput);
      const result = await wsClient.sendCommand<RegisterResult>("managed_project", "register", payload);
      setRegisterResult(result);
      setShowRegister(false);
      setJsonInput("");
      fetchProjects();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleDelete = async (key: string) => {
    if (!confirm(`"${key}" を無効化しますか？`)) return;
    try {
      await wsClient.sendCommand("managed_project", "delete", { key });
      setSelected(null);
      fetchProjects();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleOpen = async (key: string) => {
    setError(null);
    try {
      const { url } = await wsClient.sendCommand<{ url: string }>("managed_project", "open_url", { key });
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const projectList = (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h2 style={{ fontSize: "1.1rem", fontWeight: 600, margin: 0 }}>Projects</h2>
        {isAdmin && (
          <button onClick={() => setShowRegister(!showRegister)} style={{
            padding: "0.3rem 0.75rem", fontSize: "0.8rem", borderRadius: "4px",
            border: "1px solid var(--border)", background: "transparent", color: "var(--text)", cursor: "pointer",
          }}>{showRegister ? "Cancel" : "+ Add"}</button>
        )}
      </div>

      {loading ? (
        <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Loading...</p>
      ) : projects.length === 0 ? (
        <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
          {isAdmin ? "Register your first project with + Add" : "No projects available"}
        </p>
      ) : (
        <div style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(280px, 1fr))",
          gap: "0.75rem",
        }}>
          {projects.map((p) => {
            const ov = overviews[p.key];
            const hasUserData = ov !== undefined;
            const connected = p.connectionCount > 0;
            const lastConnTitle = p.lastConnectedAt
              ? `Last connected: ${new Date(p.lastConnectedAt).toLocaleString()}`
              : "Never connected via project_credentials";
            return (
              <div
                key={p.key}
                style={{
                  padding: "0.75rem 1rem",
                  borderRadius: "6px",
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.5rem",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
                  <span style={{ fontSize: "0.95rem", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                  <div style={{ display: "flex", gap: "0.25rem", flexShrink: 0 }}>
                    {!p.isActive && (
                      <span style={{ fontSize: "0.65rem", padding: "0.1rem 0.35rem", borderRadius: "2px", background: "var(--red, #f85149)", color: "#fff" }}>off</span>
                    )}
                    {p.isActive && (
                      <span
                        title={connected
                          ? `${p.connectionCount} active project_credentials connection(s)`
                          : lastConnTitle}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.25rem",
                          fontSize: "0.65rem",
                          padding: "0.1rem 0.4rem",
                          borderRadius: "2px",
                          background: connected ? "var(--green, #2ea043)" : "transparent",
                          color: connected ? "#fff" : "var(--text-muted)",
                          border: connected ? "none" : "1px solid var(--border)",
                        }}
                      >
                        <span
                          aria-hidden
                          style={{
                            display: "inline-block",
                            width: "0.4rem",
                            height: "0.4rem",
                            borderRadius: "50%",
                            background: connected ? "#fff" : "var(--text-muted)",
                          }}
                        />
                        {connected ? `使用中${p.connectionCount > 1 ? ` (${p.connectionCount})` : ""}` : "未接続"}
                      </span>
                    )}
                    {p.isActive && hasUserData && (
                      <span
                        title={`${ov.filledColumns}/${ov.totalColumns} columns filled`}
                        style={{
                          fontSize: "0.65rem",
                          padding: "0.1rem 0.4rem",
                          borderRadius: "2px",
                          background: "transparent",
                          color: ov.inUse ? "var(--text)" : "var(--text-muted)",
                          border: "1px solid var(--border)",
                        }}
                      >
                        {ov.inUse ? "データあり" : "データなし"}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{p.key}</div>
                {p.description && (
                  <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", flex: 1 }}>
                    {p.description}
                  </div>
                )}
                <div style={{ display: "flex", gap: "0.5rem", marginTop: "auto" }}>
                  <button
                    onClick={() => selectProject(p.key)}
                    style={{
                      flex: 1, padding: "0.35rem 0.5rem", fontSize: "0.8rem", borderRadius: "4px",
                      border: "1px solid var(--border)", background: "transparent", color: "var(--text)", cursor: "pointer",
                    }}
                  >詳細</button>
                  <button
                    onClick={() => handleOpen(p.key)}
                    disabled={!p.isActive}
                    style={{
                      flex: 1, padding: "0.35rem 0.5rem", fontSize: "0.8rem", borderRadius: "4px",
                      border: "1px solid var(--green, #2ea043)",
                      background: p.isActive ? "var(--green, #2ea043)" : "transparent",
                      color: p.isActive ? "#fff" : "var(--text-muted)",
                      cursor: p.isActive ? "pointer" : "not-allowed",
                      opacity: p.isActive ? 1 : 0.5,
                    }}
                  >開く</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div style={{ height: "100%", width: "100%", overflow: "auto" }}>
        <div style={{ padding: isMobile ? "1rem" : "1.5rem", width: "100%", minWidth: 0, maxWidth: "1200px", margin: "0 auto" }}>
          {error && (
            <div style={{ padding: "0.5rem 0.75rem", marginBottom: "1rem", borderRadius: "4px", background: "rgba(248,81,73,0.1)", border: "1px solid var(--red, #f85149)", fontSize: "0.85rem", color: "var(--red)" }}>
              {error}
            </div>
          )}

          {registerResult && (
            <div style={{ padding: "0.75rem", marginBottom: "1rem", borderRadius: "4px", background: "rgba(46,160,67,0.1)", border: "1px solid var(--green, #2ea043)", fontSize: "0.85rem" }}>
              <strong>{registerResult.message}</strong>
              <div style={{ marginTop: "0.5rem", fontFamily: "monospace", fontSize: "0.8rem" }}>
                Client ID: {registerResult.clientId}<br />
                Client Secret: {registerResult.clientSecret}
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.25rem" }}>
                Secret is shown only once.
              </div>
            </div>
          )}

          {/* Register form */}
          {showRegister && isAdmin && (
            <div style={{ marginBottom: "1.5rem", padding: "1rem", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "6px" }}>
              <h3 style={{ fontSize: "0.9rem", fontWeight: 600, marginBottom: "0.75rem" }}>Register Project</h3>

              {/* Template selector (dropdown) */}
              <div style={{ marginBottom: "0.75rem" }}>
                <label style={{ display: "block", fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.3rem" }}>Service Template</label>
                <select
                  onChange={(e) => { if (e.target.value) selectTemplate(e.target.value); }}
                  defaultValue=""
                  style={{
                    width: "100%", padding: "0.4rem 0.5rem", fontSize: "0.85rem", borderRadius: "4px",
                    border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)",
                  }}
                >
                  <option value="" disabled>-- Select a service template --</option>
                  {loadingTemplates ? (
                    <option disabled>Loading...</option>
                  ) : (
                    <>
                      {templates.map((t) => (
                        <option key={t.key} value={t.key}>{t.name} — {t.description || t.key}</option>
                      ))}
                      <option value="_template">+ Blank Template</option>
                    </>
                  )}
                </select>
              </div>

              <textarea
                value={jsonInput}
                onChange={(e) => setJsonInput(e.target.value)}
                placeholder="Select a template above or paste JSON definition"
                style={{ width: "100%", height: "calc(100vh - 380px)", minHeight: "300px", padding: "0.5rem", fontFamily: "monospace", fontSize: "0.8rem", borderRadius: "4px", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", boxSizing: "border-box", resize: "vertical" }}
              />
              <button className="primary" onClick={handleRegister} style={{ marginTop: "0.5rem" }}>Register</button>
            </div>
          )}

          {/* Project detail or list */}
          {selected ? (
            <div>
              <button
                onClick={() => setSelected(null)}
                style={{
                  padding: "0.3rem 0.75rem", fontSize: "0.8rem", borderRadius: "4px",
                  border: "1px solid var(--border)", background: "transparent", color: "var(--text)",
                  cursor: "pointer", marginBottom: "1rem",
                }}
              >← Back to projects</button>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem" }}>
                <div>
                  <h2 style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>{selected.name}</h2>
                  <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.25rem" }}>
                    <code>{selected.key}</code> &middot; {selected.isActive ? "Active" : "Inactive"}
                  </div>
                </div>
                {isAdmin && selected.isActive && (
                  <button onClick={() => handleDelete(selected.key)} style={{
                    padding: "0.3rem 0.75rem", fontSize: "0.8rem", borderRadius: "4px",
                    border: "1px solid var(--red, #f85149)", background: "transparent", color: "var(--red)", cursor: "pointer",
                  }}>Deactivate</button>
                )}
              </div>

              {selected.description && (
                <p style={{ fontSize: "0.85rem", marginBottom: "1rem" }}>{selected.description}</p>
              )}

              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "1rem" }}>
                {/* Connection info */}
                <div style={{ padding: "1rem", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "6px" }}>
                  <h3 style={{ fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.5rem" }}>Connection</h3>
                  <div style={{ fontSize: "0.8rem" }}>
                    <p><strong>Client ID:</strong></p>
                    <code style={{ fontSize: "0.75rem", wordBreak: "break-all" }}>{selected.clientId}</code>
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.5rem" }}>
                    Created: {new Date(selected.createdAt).toLocaleString()}
                  </div>
                </div>

                {/* Schema */}
                <div style={{ padding: "1rem", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "6px" }}>
                  <h3 style={{ fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.5rem" }}>User Data Schema</h3>
                  {selected.schemaDefinition?.user_data?.columns ? (
                    <table style={{ width: "100%", fontSize: "0.8rem", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid var(--border)" }}>
                          <th style={{ textAlign: "left", padding: "0.25rem", fontWeight: 500 }}>Column</th>
                          <th style={{ textAlign: "left", padding: "0.25rem", fontWeight: 500 }}>Type</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(selected.schemaDefinition.user_data.columns).map(([name, col]) => (
                          <tr key={name} style={{ borderBottom: "1px solid var(--border)" }}>
                            <td style={{ padding: "0.25rem" }}><code>{name}</code></td>
                            <td style={{ padding: "0.25rem", color: "var(--text-muted)" }}>{col.type}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>No user data columns defined</p>
                  )}
                </div>
              </div>
            </div>
          ) : (
            projectList
          )}
        </div>
      </div>
  );
}
