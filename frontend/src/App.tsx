import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { AppLayout } from "./components/AppLayout";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ProfilePage } from "./pages/ProfilePage";
import { DataOptOutPage } from "./pages/DataOptOutPage";
import { OrganizationsPage } from "./pages/OrganizationsPage";
import { OidcClientsPage } from "./pages/admin/OidcClientsPage";
import { CompositeLoginPage } from "./pages/composite/CompositeLoginPage";
import { CompositeCallbackPage } from "./pages/composite/CompositeCallbackPage";
import { DeviceRegisterPage } from "./pages/DeviceRegisterPage";
import { OidcConsentPage } from "./pages/oidc/OidcConsentPage";
import { CheckinPage } from "./pages/CheckinPage";

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

      {/* OIDC: 認可同意 (Cernere を IdP とする RP の consent) */}
      <Route path="/oidc/consent" element={<OidcConsentPage />} />

      {/* 会場チェックイン (session ベース、 passkey 再入力なし。 QR/クエリで gateway を渡す) */}
      <Route path="/checkin" element={<CheckinPage />} />

      {/* 他デバイス登録 (one-time link で新しい端末の passkey を追加) */}
      <Route path="/device-register" element={<DeviceRegisterPage />} />

      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      {/* 認証済みページは AppLayout 内で描画 — WS 接続を維持 */}
      <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/data-optout" element={<DataOptOutPage />} />
        <Route path="/organizations" element={<OrganizationsPage />} />
        <Route path="/oidc-clients" element={<OidcClientsPage />} />
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
