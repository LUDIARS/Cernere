/**
 * <PasskeyLoginSection>
 *
 * 「パスキーで続ける」の主ボタン。画面を開いた時点で ceremony は自動起動済みなので、
 * 取消・失敗の後は再試行ボタンになる。WebAuthn は「パスキーが無い」と「取消」を
 * 区別できないため、失敗しても「アカウントが無い」とは言わない (SPEC-PASSKEY-CONTINUE)。
 */

import type { ReactElement } from "react";
import type { CompositeLoginLabels } from "./login-labels.js";
import { hintStyle, primaryButtonStyle } from "./login-styles.js";
import type { PasskeyLoginPhase } from "./usePasskeyLogin.js";

export interface PasskeyLoginSectionProps {
  phase: PasskeyLoginPhase;
  hasAttempted: boolean;
  /** 直前にエラー表示がある場合は未完了の文言を重ねない */
  hasError: boolean;
  onStart: () => void;
  labels: CompositeLoginLabels;
}

/** @implements SPEC-PASSKEY-CONTINUE */
export function PasskeyLoginSection({
  phase,
  hasAttempted,
  hasError,
  onStart,
  labels: l,
}: PasskeyLoginSectionProps): ReactElement {
  const busy = phase === "running";
  return (
    <>
      <button type="button" onClick={onStart} disabled={busy} style={{ ...primaryButtonStyle(busy), marginTop: 0 }}>
        {busy ? l.passkeyRunning : hasAttempted ? l.passkeyRetry : l.passkeyContinue}
      </button>
      {phase === "unsupported" && (
        <p style={{ ...hintStyle, marginTop: "0.5rem" }}>{l.passkeyUnsupported}</p>
      )}
      {phase === "fallback" && !hasError && (
        <p style={{ ...hintStyle, marginTop: "0.5rem" }}>{l.passkeyNotCompleted}</p>
      )}
    </>
  );
}
