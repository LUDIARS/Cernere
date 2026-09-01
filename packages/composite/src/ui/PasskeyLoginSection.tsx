/**
 * <PasskeyLoginSection>
 *
 * ログインタブのパスキー導線。 画面を開いた時点で ceremony は自動起動済みなので、
 * ここに出るボタンは再試行用。 自動起動が空振りした / 非対応だった理由だけ添える。
 */

import type { ReactElement } from "react";
import type { CompositeLoginLabels } from "./login-labels.js";
import { hintStyle, secondaryButtonStyle } from "./login-styles.js";
import type { PasskeyLoginPhase } from "./usePasskeyLogin.js";

export interface PasskeyLoginSectionProps {
  phase: PasskeyLoginPhase;
  hasAttempted: boolean;
  /** 他の処理 (パスワード送信等) が走っていて押せない */
  disabled: boolean;
  /** パスワードフォームが無い (auth_mode=passkey) ときは文言をパスキー完結に寄せる */
  passkeyOnly: boolean;
  /** 直前にエラー表示がある場合は fallback 文言を重ねない */
  hasError: boolean;
  onStart: () => void;
  labels: CompositeLoginLabels;
}

/** @implements SPEC-COMPOSITE-PASSKEY-AUTOSTART */
export function PasskeyLoginSection({
  phase,
  hasAttempted,
  disabled,
  passkeyOnly,
  hasError,
  onStart,
  labels: l,
}: PasskeyLoginSectionProps): ReactElement {
  const busy = phase === "running";
  const blocked = disabled || busy;
  return (
    <>
      <button
        type="button"
        onClick={onStart}
        disabled={blocked}
        style={secondaryButtonStyle(blocked)}
      >
        {busy ? l.passkeyRunning : hasAttempted ? l.passkeyRetry : l.passkeyLogin}
      </button>

      {phase === "unsupported" && (
        <p style={{ ...hintStyle, marginTop: "0.5rem" }}>
          {passkeyOnly ? l.passkeyUnsupported : l.passkeyUnsupportedFallback}
        </p>
      )}
      {phase === "fallback" && !hasError && (
        <p style={{ ...hintStyle, marginTop: "0.5rem" }}>
          {passkeyOnly ? l.passkeyFallback : l.passkeyFallbackWithForm}
        </p>
      )}
    </>
  );
}
