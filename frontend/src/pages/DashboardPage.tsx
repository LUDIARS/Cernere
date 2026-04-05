import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../contexts/AuthContext";
import { wsClient } from "../lib/ws-client";

interface ManagedProject {
  key: string;
  name: string;
  description: string;
  isActive: boolean;
  createdAt: string;
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

export function DashboardPage() {
  const { user, wsConnected, logout } = useAuth();
  const isAdmin = user?.role === "admin";

  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [selected, setSelected] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Admin: register form
  const [showRegister, setShowRegister] = useState(false);
  const [jsonInput, setJsonInput] = useState("");
  const [registerResult, setRegisterResult] = useState<RegisterResult | null>(null);
  const [templates, setTemplates] = useState<Array<{ key: string; name: string; description: string }>>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);

  // Fetch projects
  const fetchProjects = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await wsClient.sendCommand<ManagedProject[]>("managed_project", "list");
      setProjects(result);
    } catch (err) {
      console.error("[Dashboard] Failed to fetch projects:", err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (wsConnected) fetchProjects();
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

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      {/* Header bar */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "0.75rem 1.5rem",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-surface)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <h1 style={{ fontSize: "1rem", fontWeight: 700, margin: 0 }}>Cernere</h1>
          <span style={{
            fontSize: "0.7rem", padding: "0.1rem 0.5rem", borderRadius: "3px",
            background: wsConnected ? "var(--green, #2ea043)" : "var(--yellow, #d29922)",
            color: "#fff",
          }}>
            {wsConnected ? "connected" : "connecting..."}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", fontSize: "0.85rem" }}>
          {user && <span>{user.name} <span style={{ color: "var(--text-muted)" }}>({user.role})</span></span>}
          <a href="/profile" style={{ color: "var(--text-muted)", textDecoration: "none" }}>Profile</a>
          <a href="/data-optout" style={{ color: "var(--text-muted)", textDecoration: "none" }}>Data</a>
          <button onClick={logout} style={{
            padding: "0.25rem 0.75rem", fontSize: "0.8rem", borderRadius: "4px",
            border: "1px solid var(--border)", background: "transparent", color: "var(--text)", cursor: "pointer",
          }}>Logout</button>
        </div>
      </div>

      <div style={{ display: "flex", height: "calc(100vh - 49px)" }}>
        {/* Sidebar: project list */}
        <div style={{
          width: 280, borderRight: "1px solid var(--border)", background: "var(--bg-surface)",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{ padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "0.8rem", fontWeight: 600, textTransform: "uppercase", color: "var(--text-muted)" }}>Projects</span>
            {isAdmin && (
              <button onClick={() => setShowRegister(!showRegister)} style={{
                padding: "0.15rem 0.5rem", fontSize: "0.75rem", borderRadius: "3px",
                border: "1px solid var(--border)", background: "transparent", color: "var(--text)", cursor: "pointer",
              }}>{showRegister ? "Cancel" : "+ Add"}</button>
            )}
          </div>

          <div style={{ flex: 1, overflow: "auto", padding: "0.25rem" }}>
            {loading ? (
              <p style={{ padding: "1rem", color: "var(--text-muted)", fontSize: "0.8rem" }}>Loading...</p>
            ) : projects.length === 0 ? (
              <p style={{ padding: "1rem", color: "var(--text-muted)", fontSize: "0.8rem" }}>No projects</p>
            ) : (
              projects.map((p) => (
                <div
                  key={p.key}
                  onClick={() => selectProject(p.key)}
                  style={{
                    padding: "0.5rem 0.75rem", borderRadius: "4px", cursor: "pointer",
                    background: selected?.key === p.key ? "var(--bg-hover, rgba(255,255,255,0.05))" : "transparent",
                    marginBottom: "2px",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: "0.85rem", fontWeight: 500 }}>{p.name}</span>
                    {!p.isActive && (
                      <span style={{ fontSize: "0.65rem", padding: "0 0.3rem", borderRadius: "2px", background: "var(--red, #f85149)", color: "#fff" }}>off</span>
                    )}
                  </div>
                  <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{p.key}</div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Main content */}
        <div style={{ flex: 1, overflow: "auto", padding: "1.5rem" }}>
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

          {/* Project detail */}
          {selected ? (
            <div>
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

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
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
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)", fontSize: "0.9rem" }}>
              {projects.length > 0 ? "Select a project from the sidebar" : isAdmin ? "Register your first project with + Add" : "No projects available"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
