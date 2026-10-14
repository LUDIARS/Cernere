/**
 * 名前の後入れ (SPEC-DISPLAY-NAME-DEFERRED)。
 * 名前を保存したら、対応ブラウザでは認証器に表示される名前も更新する (Signal API)。
 */

import { useState } from "react";
import { panelStyle, panelTitleStyle, bodyTextStyle, inputStyle, messageStyle, primaryButton } from "../../components/security/panel-styles";
import { getStoredUser, profile, setStoredUser } from "../../lib/api";
import { signalCurrentUserName } from "../../lib/webauthn-signal";

const MAX_NAME = 80;

export function NameStep({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError("");
    try {
      await profile.setDisplayName(trimmed);
      const stored = getStoredUser();
      if (stored) {
        setStoredUser({ ...stored, name: trimmed });
        void signalCurrentUserName(stored.id, trimmed);
      }
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={panelStyle}>
      <h2 style={panelTitleStyle}>👤 名前</h2>
      <p style={bodyTextStyle}>Cernere とつながるサービスに表示される名前です。あとから変えられます。</p>
      {error && <div role="alert" style={messageStyle(true)}>{error}</div>}
      <input
        value={name}
        maxLength={MAX_NAME}
        autoComplete="nickname"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
        placeholder="表示名"
        style={inputStyle}
      />
      <button type="button" onClick={() => { void save(); }} disabled={busy || !name.trim()} style={{ ...primaryButton(busy || !name.trim()), marginTop: "0.75rem" }}>
        保存して次へ
      </button>
    </div>
  );
}
