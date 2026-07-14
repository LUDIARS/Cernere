import { useEffect, useRef, useState } from "react";

const DEFAULT_POPUP_FEATURES = "popup,width=480,height=640,resizable=yes,scrollbars=yes";

export interface CompositePasskeyPopupProps {
  cernereUrl: string;
  onAuthCode: (authCode: string) => void | Promise<void>;
  onError?: (error: Error) => void;
  origin?: string;
  buttonLabel?: string;
  pendingLabel?: string;
  className?: string;
  disabled?: boolean;
  timeoutMs?: number;
  popupName?: string;
  popupFeatures?: string;
}

interface CernereAuthMessage {
  type: "cernere:auth";
  authCode: string;
}

export function buildCompositePasskeyLoginUrl(
  cernereUrl: string,
  origin: string,
): string {
  const url = new URL("/composite/login", cernereUrl);
  url.searchParams.set("origin", new URL(origin).origin);
  url.searchParams.set("auth_mode", "passkey");
  return url.toString();
}

function isCernereAuthMessage(value: unknown): value is CernereAuthMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.type === "cernere:auth"
    && typeof message.authCode === "string"
    && message.authCode.length > 0;
}

/**
 * Opens the Cernere-hosted passkey ceremony and returns its one-time auth code.
 * WebAuthn intentionally stays on the Cernere origin so its RP ID remains valid.
 */
export function CompositePasskeyPopup({
  cernereUrl,
  onAuthCode,
  onError,
  origin,
  buttonLabel = "ログイン",
  pendingLabel = "ログイン中...",
  className,
  disabled = false,
  timeoutMs = 120_000,
  popupName = "cernere-passkey-login",
  popupFeatures = DEFAULT_POPUP_FEATURES,
}: CompositePasskeyPopupProps) {
  const [pending, setPending] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const fail = (error: Error) => {
    setPending(false);
    onError?.(error);
  };

  const openPopup = () => {
    cleanupRef.current?.();

    let loginUrl: string;
    let expectedOrigin: string;
    try {
      const callerOrigin = origin ?? window.location.origin;
      loginUrl = buildCompositePasskeyLoginUrl(cernereUrl, callerOrigin);
      expectedOrigin = new URL(cernereUrl).origin;
    } catch {
      fail(new Error("Cernere URL または呼び出し元 origin が不正です"));
      return;
    }

    const popup = window.open(loginUrl, popupName, popupFeatures);
    if (!popup) {
      fail(new Error("ログイン画面を開けませんでした。ポップアップを許可してください"));
      return;
    }

    setPending(true);
    let settled = false;
    const cleanup = () => {
      window.removeEventListener("message", handleMessage);
      window.clearInterval(closeTimer);
      window.clearTimeout(timeoutTimer);
      cleanupRef.current = null;
    };
    const settleError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      fail(error);
    };
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (settled
        || event.origin !== expectedOrigin
        || event.source !== popup
        || !isCernereAuthMessage(event.data)) {
        return;
      }
      settled = true;
      cleanup();
      setPending(false);
      popup.close();
      void Promise.resolve(onAuthCode(event.data.authCode)).catch((error: unknown) => {
        fail(error instanceof Error ? error : new Error("ログイン処理に失敗しました"));
      });
    };
    const closeTimer = window.setInterval(() => {
      if (popup.closed) settleError(new Error("ログインがキャンセルされました"));
    }, 500);
    const timeoutTimer = window.setTimeout(() => {
      popup.close();
      settleError(new Error("ログインがタイムアウトしました"));
    }, timeoutMs);

    window.addEventListener("message", handleMessage);
    cleanupRef.current = cleanup;
    popup.focus();
  };

  return (
    <button
      type="button"
      className={className}
      disabled={disabled || pending}
      onClick={openPopup}
    >
      {pending ? pendingLabel : buttonLabel}
    </button>
  );
}
