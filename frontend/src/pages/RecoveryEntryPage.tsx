import { useState } from "react";
import { pageStyle, panelStyle, primaryButton } from "../components/security/panel-styles";

export function RecoveryEntryPage() {
  const [contact, setContact] = useState(false);
  return <main style={pageStyle}>
    <h1>アカウントを復旧する</h1>
    <div style={{ ...panelStyle, display: "grid", gap: "1rem" }}>
      <a href="/recover/qr">リカバリー用のQRから復元する</a>
      <button type="button" style={primaryButton(false)} onClick={() => setContact(true)}>管理者に連絡する</button>
    </div>
    {contact && <section style={panelStyle} aria-live="polite">
      <h2>管理者への連絡</h2>
      <p>利用しているサービスの管理者に、アカウントを復旧したいことをお伝えください。</p>
      <p>本人確認後に管理者から届く復旧リンクを開き、新しいパスキーを登録してください。</p>
    </section>}
    <p><a href="/login">ログインに戻る</a></p>
  </main>;
}
