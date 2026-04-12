import { Link, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useIsMobile } from "../hooks/useIsMobile";

const navItems = [
  { path: "/", label: "Dashboard" },
  { path: "/organizations", label: "Organizations" },
  { path: "/profile", label: "Profile" },
  { path: "/data-optout", label: "Data" },
];

export function AppLayout() {
  const { user, wsConnected, logout } = useAuth();
  const location = useLocation();
  const isMobile = useIsMobile();

  const statusBadge = (
    <span style={{
      fontSize: "0.65rem", padding: "0.1rem 0.4rem", borderRadius: "3px",
      background: wsConnected ? "var(--green, #2ea043)" : "var(--yellow, #d29922)",
      color: "#fff",
    }}>
      {wsConnected ? "connected" : "connecting..."}
    </span>
  );

  const userBlock = user && (
    <span style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>
      {user.name}
    </span>
  );

  const logoutButton = (
    <button onClick={logout} style={{
      padding: "0.2rem 0.6rem", fontSize: "0.75rem", borderRadius: "4px",
      border: "1px solid var(--border)", background: "transparent", color: "var(--text)", cursor: "pointer",
    }}>Logout</button>
  );

  const navMenu = (
    <div style={{
      display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem",
      flexWrap: "wrap",
    }}>
      {navItems.map((item) => (
        <Link
          key={item.path}
          to={item.path}
          style={{
            padding: "0.25rem 0.6rem",
            borderRadius: "4px",
            textDecoration: "none",
            color: location.pathname === item.path ? "var(--text)" : "var(--text-muted)",
            background: location.pathname === item.path ? "var(--bg-hover, rgba(255,255,255,0.05))" : "transparent",
            fontWeight: location.pathname === item.path ? 600 : 400,
          }}
        >
          {item.label}
        </Link>
      ))}
    </div>
  );

  return (
    <div style={{
      minHeight: "100dvh", width: "100%", maxWidth: "100vw",
      background: "var(--bg)", display: "flex", flexDirection: "column",
      overflowX: "hidden",
    }}>
      {/* Header */}
      {isMobile ? (
        <div style={{
          display: "flex", flexDirection: "column",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-surface)",
          flexShrink: 0,
        }}>
          {/* 1行目: Cernere / 接続状況 / 名前 / Logout */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "0.4rem 0.75rem",
            gap: "0.5rem",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0 }}>
              <Link to="/" style={{ textDecoration: "none", color: "var(--text)" }}>
                <span style={{ fontSize: "1rem", fontWeight: 700 }}>Cernere</span>
              </Link>
              {statusBadge}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0 }}>
              {userBlock}
              {logoutButton}
            </div>
          </div>
          {/* 2行目: メニュー */}
          <div style={{
            padding: "0.25rem 0.75rem 0.4rem",
            borderTop: "1px solid var(--border)",
          }}>
            {navMenu}
          </div>
        </div>
      ) : (
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "0.5rem 1.5rem",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-surface)",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <Link to="/" style={{ textDecoration: "none", color: "var(--text)" }}>
              <span style={{ fontSize: "1rem", fontWeight: 700 }}>Cernere</span>
            </Link>
            {statusBadge}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            {navMenu}
            {userBlock && <span style={{ marginLeft: "0.5rem" }}>{userBlock}</span>}
            <span style={{ marginLeft: "0.25rem" }}>{logoutButton}</span>
          </div>
        </div>
      )}

      {/* Page content */}
      <div style={{ flex: 1, overflow: "auto" }}>
        <Outlet />
      </div>
    </div>
  );
}
