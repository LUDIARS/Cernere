import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { AppLayout } from "./components/AppLayout";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ProfilePage } from "./pages/ProfilePage";
import { DataOptOutPage } from "./pages/DataOptOutPage";
import { OrganizationsPage } from "./pages/OrganizationsPage";
import { OidcClientsPage } from "./pages/admin/OidcClientsPage";
import { EnterpriseConnectionsPage } from "./pages/admin/EnterpriseConnectionsPage";
import { CompositeLoginPage } from "./pages/composite/CompositeLoginPage";
import { CompositeCallbackPage } from "./pages/composite/CompositeCallbackPage";
import { DeviceRegisterPage } from "./pages/DeviceRegisterPage";
import { OidcConsentPage } from "./pages/oidc/OidcConsentPage";
import { ConsentPage } from "./pages/consent/ConsentPage";
import { CheckinPage } from "./pages/CheckinPage";
import { OnboardingPage } from "./pages/onboarding/OnboardingPage";
import { StartPage } from "./pages/onboarding/StartPage";
import { onboardingUrl } from "./pages/onboarding/onboarding-return";
import { SecurityPage } from "./pages/SecurityPage";
import { AccessPage } from "./pages/AccessPage";
import { AccessReviewPage } from "./pages/admin/AccessReviewPage";
import { AccessGate } from "./components/AccessGate";
import { DeviceSessionsPage } from "./pages/DeviceSessionsPage";
import { PasskeyRecoveryPage } from "./pages/PasskeyRecoveryPage";
import { AccountRecoveryPage } from "./pages/admin/AccountRecoveryPage";
import { OnsiteKiosksPage } from "./pages/admin/OnsiteKiosksPage";
import { ContinueMenuPage } from "./pages/continue/ContinueMenuPage";
import { JoinRequestPage } from "./pages/federate/JoinRequestPage";
import { ApprovePage } from "./pages/federate/ApprovePage";
import { FederationPage } from "./pages/settings/FederationPage";
import { PasskeyEnrollmentPage } from "./pages/PasskeyEnrollmentPage";

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
  // 名前は初回ログインの後に入れる (SPEC-DISPLAY-NAME-DEFERRED)。未設定ならオンボーディングへ。
  if (!user.name) return <Navigate to={onboardingUrl(window.location.pathname)} replace />;
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
      <Route path="/recover" element={<PasskeyRecoveryPage />} />
      {/* Composite: 他サービス組み込み用 (アプリシェルなし) */}
      <Route path="/composite/login" element={<CompositeLoginPage />} />
      <Route path="/composite/callback" element={<CompositeCallbackPage />} />

      {/* OIDC: 認可同意 (Cernere を IdP とする RP の consent) */}
      <Route path="/oidc/consent" element={<OidcConsentPage />} />

      {/* サービス初回ログイン時の権限確認 (consentTicket。popup / 別タブで開く、アプリシェルなし) */}
      <Route path="/consent" element={<ConsentPage />} />

      {/* 会場チェックイン (session ベース、 passkey 再入力なし。 QR/クエリで gateway を渡す) */}
      <Route path="/checkin" element={<CheckinPage />} />

      {/* 他デバイス登録 (one-time link で新しい端末の passkey を追加) */}
      <Route path="/device-register" element={<DeviceRegisterPage />} />

      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      {/* 引き継ぎメニュー (押したログインでパスキーが見つからなかったとき)。account-federation §4 */}
      <Route path="/continue" element={<ContinueMenuPage />} />
      <Route path="/passkeys/register" element={<PasskeyEnrollmentPage />} />
      {/* 引き継ぎ: 加わる側 (新しい端末 / 既存アカウント) と承認する側 (使っている端末) */}
      <Route path="/federate/join" element={<JoinRequestPage />} />
      <Route path="/federate/approve" element={<ApprovePage />} />
      {/* はじめての方: 名前 →「はじめる」でパスキーとアカウントを作る。ログイン済みなら不要 */}
      <Route path="/start" element={user ? <Navigate to="/" replace /> : <StartPage />} />
      {/* 新しく始めた直後の設定 (名前・リカバリー QR・別端末・通知)。アプリシェルの外 */}
      <Route path="/onboarding" element={user ? <OnboardingPage /> : <Navigate to="/login" replace />} />
      {/* 認証済みページは AppLayout 内で描画 — WS 接続を維持 */}
      <Route element={<RequireAuth><AccessGate><AppLayout /></AccessGate></RequireAuth>}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/devices" element={<DeviceSessionsPage />} />
        <Route path="/security" element={<SecurityPage />} />
        <Route path="/settings/federation" element={<FederationPage />} />
        <Route path="/access" element={<AccessPage />} />
        <Route path="/admin/access" element={<AccessReviewPage />} />
        <Route path="/account-recovery" element={<AccountRecoveryPage />} />
        <Route path="/data-optout" element={<DataOptOutPage />} />
        <Route path="/organizations" element={<OrganizationsPage />} />
        <Route path="/oidc-clients" element={<OidcClientsPage />} />
        <Route path="/enterprise" element={<EnterpriseConnectionsPage />} />
        <Route path="/onsite-kiosks" element={<OnsiteKiosksPage />} />
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
