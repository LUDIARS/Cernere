import { Link } from "react-router-dom";
import { AlertTargetsPanel } from "../../components/security/AlertTargetsPanel";
import { PairingPanel } from "../../components/security/PairingPanel";
import { bodyTextStyle, pageStyle, panelStyle, panelTitleStyle } from "../../components/security/panel-styles";
import { useAuth } from "../../contexts/AuthContext";
import { LinkedAccountsSection } from "../LinkedAccountsSection";
import { MfaSettingsSection } from "../MfaSettingsSection";
import { DeviceSessionsPanel } from "./DeviceSessionsPanel";
import { PasskeySection } from "./PasskeySection";
import { RecoveryPanels, SecurityEventsPanel } from "./SecuritySections";

/**
 * 一般メニュー「端末とログイン」。旧「端末」「セキュリティ」とプロフィールのパスキー一覧を 1 画面にまとめる。
 * 上段: パスキー・QR での別の端末の追加・リカバリー QR。
 * 下段: ログイン中の端末・連携アカウント・最近の出来事・通知先。
 * ログイン画面のヘルプ (LoginHelp) はこの画面名で案内している。
 */
export function DevicesAndLoginPage() {
  const { user } = useAuth();
  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700 }}>端末とログイン</h1>
      <PasskeySection />
      <PairingPanel title="📱 別の端末を追加する" />
      <RecoveryPanels />

      <DeviceSessionsPanel />
      <LinkedAccountsSection />
      {user?.id && <MfaSettingsSection userId={user.id} />}
      <div style={panelStyle}>
        <h2 style={panelTitleStyle}>アカウントの連携</h2>
        <p style={bodyTextStyle}>
          別のアカウントの端末をこのアカウントにまとめるときは、<Link to="/settings/federation">アカウントの連携</Link> を開きます。
        </p>
      </div>
      <SecurityEventsPanel />
      <AlertTargetsPanel />
    </main>
  );
}
