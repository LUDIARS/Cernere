import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { AppLayout } from "./components/AppLayout";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ProfilePage } from "./pages/ProfilePage";
import { DataOptOutPage } from "./pages/DataOptOutPage";
import { OrganizationsPage } from "./pages/OrganizationsPage";
import { CompositeLoginPage } from "./pages/composite/CompositeLoginPage";
import { CompositeCallbackPage } from "./pages/composite/CompositeCallbackPage";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        <span style={{ color: "var(--text-muted)" }}>Loading...</span>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        <span style={{ color: "var(--text-muted)" }}>Loading...</span>
      </div>
    );
  }

  return (
    <Routes>
      {/* Composite: 他サービス組み込み用 (アプリシェルなし) */}
      <Route path="/composite/login" element={<CompositeLoginPage />} />
      <Route path="/composite/callback" element={<CompositeCallbackPage />} />

      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      {/* 認証済みページは AppLayout 内で描画 — WS 接続を維持 */}
      <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/data-optout" element={<DataOptOutPage />} />
        <Route path="/organizations" element={<OrganizationsPage />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
