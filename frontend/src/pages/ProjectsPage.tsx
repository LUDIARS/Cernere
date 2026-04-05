import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../contexts/AuthContext";
import { wsClient } from "../lib/ws-client";
import { getAccessToken } from "../lib/api.js";

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
  name: string;
  clientId: string;
  clientSecret: string;
  tableCreated: boolean;
  columnsAdded: string[];
}

export function ProjectsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [selected, setSelected] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  // 登録フォーム
  const [showRegister, setShowRegister] = useState(false);
  const [jsonInput, setJsonInput] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [registerResult, setRegisterResult] = useState<RegisterResult | null>(null);

  // WS 接続
  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;

    wsClient.connect(token).then(() => {
      setWsConnected(true);
    }).catch((err) => {
      setError(`WebSocket 接続失敗: ${err.message}`);
    });

    return () => wsClient.disconnect();
  }, []);

  // プロジェクト一覧取得
  const fetchProjects = useCallback(async () => {
    if (!wsConnected) return;
    try {
      setLoading(true);
      const result = await wsClient.sendCommand<ManagedProject[]>("managed_project", "list");
      setProjects(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [wsConnected]);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  // プロジェクト詳細
  const selectProject = async (key: string) => {
    try {
      const detail = await wsClient.sendCommand<ProjectDetail>("managed_project", "get", { key });
      setSelected(detail);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // 登録
  const handleRegister = async () => {
    setError(null);
    setRegisterResult(null);
    try {
      let payload: unknown;
      if (urlInput.trim()) {
        payload = { url: urlInput.trim() };
      } else {
        payload = JSON.parse(jsonInput);
      }
      const result = await wsClient.sendCommand<RegisterResult>("managed_project", "register", payload);
      setRegisterResult(result);
      setShowRegister(false);
      setJsonInput("");
      setUrlInput("");
      fetchProjects();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // 削除
  const handleDelete = async (key: string) => {
    if (!confirm(`プロジェクト "${key}" を無効化しますか？`)) return;
    try {
      await wsClient.sendCommand("managed_project", "delete", { key });
      setSelected(null);
      fetchProjects();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", padding: "2rem" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
          <div>
            <h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>Project Management</h1>
            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", margin: 0 }}>
              {wsConnected ? "Connected" : "Connecting..."}
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <a href="/"><button style={btnStyle}>Dashboard</button></a>
            {isAdmin && (
              <button className="primary" onClick={() => setShowRegister(!showRegister)}>
                {showRegister ? "Cancel" : "+ Register Project"}
              </button>
            )}
          </div>
        </div>

        {error && <div style={errorStyle}>{error}</div>}

        {/* Register result */}
        {registerResult && (
          <div style={successStyle}>
            <strong>{registerResult.message}</strong>
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem" }}>
              Client ID: <code>{registerResult.clientId}</code><br />
              Client Secret: <code>{registerResult.clientSecret}</code>
              <br /><small style={{ color: "var(--text-muted)" }}>Secret is shown only once. Save it now.</small>
            </p>
          </div>
        )}

        {/* Register form */}
        {showRegister && isAdmin && (
          <div style={cardStyle}>
            <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "1rem" }}>Register Project</h2>

            <div style={{ marginBottom: "1rem" }}>
              <label style={labelStyle}>URL (JSON)</label>
              <input
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://example.com/project-definition.json"
                style={inputStyle}
              />
            </div>

            <div style={{ textAlign: "center", fontSize: "0.8rem", color: "var(--text-muted)", margin: "0.5rem 0" }}>
              or
            </div>

            <div style={{ marginBottom: "1rem" }}>
              <label style={labelStyle}>JSON Definition</label>
              <textarea
                value={jsonInput}
                onChange={(e) => setJsonInput(e.target.value)}
                placeholder={`{
  "project": {
    "key": "my_project",
    "name": "My Project",
    "description": "..."
  },
  "user_data": {
    "columns": {
      "field_name": { "type": "text", "nullable": true }
    }
  }
}`}
                rows={12}
                style={{ ...inputStyle, fontFamily: "monospace", fontSize: "0.8rem" }}
              />
            </div>

            <button className="primary" onClick={handleRegister}>Register</button>
          </div>
        )}

        {/* Project list + detail */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>

          {/* List */}
          <div style={cardStyle}>
            <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.75rem" }}>Projects</h2>
            {loading ? (
              <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Loading...</p>
            ) : projects.length === 0 ? (
              <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>No projects registered</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                {projects.map((p) => (
                  <div
                    key={p.key}
                    onClick={() => selectProject(p.key)}
                    style={{
                      padding: "0.5rem 0.75rem",
                      borderRadius: "var(--radius-sm, 4px)",
                      cursor: "pointer",
                      background: selected?.key === p.key ? "var(--bg-hover, #f0f0f0)" : "transparent",
                      border: "1px solid transparent",
                      transition: "background 0.15s",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <strong style={{ fontSize: "0.9rem" }}>{p.name}</strong>
                      <span
                        style={{
                          fontSize: "0.7rem",
                          padding: "0.1rem 0.4rem",
                          borderRadius: "3px",
                          background: p.isActive ? "var(--green, #2ea043)" : "var(--red, #f85149)",
                          color: "#fff",
                        }}
                      >
                        {p.isActive ? "active" : "inactive"}
                      </span>
                    </div>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{p.key}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Detail */}
          <div style={cardStyle}>
            <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.75rem" }}>Detail</h2>
            {selected ? (
              <div style={{ fontSize: "0.85rem" }}>
                <p><strong>Key:</strong> <code>{selected.key}</code></p>
                <p><strong>Name:</strong> {selected.name}</p>
                <p><strong>Description:</strong> {selected.description || "—"}</p>
                <p><strong>Client ID:</strong> <code style={{ fontSize: "0.75rem" }}>{selected.clientId}</code></p>
                <p><strong>Active:</strong> {selected.isActive ? "Yes" : "No"}</p>
                <p><strong>Created:</strong> {new Date(selected.createdAt).toLocaleString()}</p>

                {selected.schemaDefinition?.user_data?.columns && (
                  <>
                    <h3 style={{ fontSize: "0.9rem", marginTop: "1rem" }}>User Data Columns</h3>
                    <table style={{ width: "100%", fontSize: "0.8rem", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid var(--border)" }}>
                          <th style={{ textAlign: "left", padding: "0.25rem" }}>Column</th>
                          <th style={{ textAlign: "left", padding: "0.25rem" }}>Type</th>
                          <th style={{ textAlign: "left", padding: "0.25rem" }}>Nullable</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(selected.schemaDefinition.user_data.columns).map(([name, col]) => (
                          <tr key={name} style={{ borderBottom: "1px solid var(--border)" }}>
                            <td style={{ padding: "0.25rem" }}><code>{name}</code></td>
                            <td style={{ padding: "0.25rem" }}>{col.type}</td>
                            <td style={{ padding: "0.25rem" }}>{col.nullable !== false ? "yes" : "no"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}

                {isAdmin && selected.isActive && (
                  <button
                    className="danger"
                    onClick={() => handleDelete(selected.key)}
                    style={{ marginTop: "1rem" }}
                  >
                    Deactivate Project
                  </button>
                )}
              </div>
            ) : (
              <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Select a project</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Styles
const cardStyle: React.CSSProperties = {
  background: "var(--bg-surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 8px)",
  padding: "1.25rem",
};

const btnStyle: React.CSSProperties = {
  padding: "0.4rem 1rem",
  borderRadius: "var(--radius-sm, 4px)",
  border: "1px solid var(--border)",
  background: "var(--bg-surface)",
  color: "var(--text)",
  cursor: "pointer",
};

const errorStyle: React.CSSProperties = {
  padding: "0.75rem",
  background: "rgba(248,81,73,0.1)",
  border: "1px solid var(--red, #f85149)",
  borderRadius: "var(--radius-sm, 4px)",
  marginBottom: "1rem",
  fontSize: "0.85rem",
  color: "var(--red, #f85149)",
};

const successStyle: React.CSSProperties = {
  padding: "0.75rem",
  background: "rgba(46,160,67,0.1)",
  border: "1px solid var(--green, #2ea043)",
  borderRadius: "var(--radius-sm, 4px)",
  marginBottom: "1rem",
  fontSize: "0.85rem",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.8rem",
  color: "var(--text-muted)",
  marginBottom: "0.25rem",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem",
  borderRadius: "var(--radius-sm, 4px)",
  border: "1px solid var(--border)",
  background: "var(--bg-surface)",
  color: "var(--text)",
  fontSize: "0.85rem",
  boxSizing: "border-box" as const,
};
