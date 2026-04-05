import { useAuth } from "../contexts/AuthContext";

export function DashboardPage() {
  const { user, logout } = useAuth();

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", padding: "2rem" }}>
      <div
        style={{
          maxWidth: 600,
          margin: "0 auto",
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "2rem",
        }}
      >
        <h1 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "1rem" }}>
          Cernere Dashboard
        </h1>

        {user && (
          <div style={{ marginBottom: "1.5rem" }}>
            <p>
              <strong>Name:</strong> {user.name}
            </p>
            <p>
              <strong>Email:</strong> {user.email}
            </p>
            <p>
              <strong>Role:</strong>{" "}
              <span className="badge blue">{user.role}</span>
            </p>
          </div>
        )}

        <div style={{ display: "flex", gap: "0.75rem" }}>
          <a href="/profile">
            <button className="primary">プロファイル設定</button>
          </a>
          <a href="/organizations">
            <button style={{
              padding: "0.4rem 1rem",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border)",
              background: "var(--bg-surface)",
              color: "var(--text)",
              cursor: "pointer",
            }}>組織管理</button>
          </a>
          <a href="/data-optout">
            <button style={{
              padding: "0.4rem 1rem",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border)",
              background: "var(--bg-surface)",
              color: "var(--text)",
              cursor: "pointer",
            }}>データ管理</button>
          </a>
          <button onClick={logout} className="danger">
            Logout
          </button>
        </div>
      </div>
    </div>
  );
}
