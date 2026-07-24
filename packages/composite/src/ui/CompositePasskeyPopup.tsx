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
  /** auto は PC で同一ウィンドウ、モバイルで popup を使う。 */
  navigationMode?: "auto" | "same-window" | "popup";
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

export function buildCompositePasskeyRedirectLoginUrl(
  cernereUrl: string,
  redirectUri: string,
): string {
  const url = new URL("/composite/login", cernereUrl);
  url.searchParams.set("redirect_uri", new URL(redirectUri).toString());
  url.searchParams.set("auth_mode", "passkey");
  return url.toString();
}

function isMobileBrowser(): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

const REDIRECT_STATE_KEY = "cernere:composite:redirect-state";

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
  navigationMode = "auto",
}: CompositePasskeyPopupProps) {
  const [pending, setPending] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  useEffect(() => {
    const callbackUrl = new URL(window.location.href);
    const state = callbackUrl.searchParams.get("cernere_composite_state");
    const authCode = callbackUrl.searchParams.get("code");
    if (!state || !authCode) return;

    callbackUrl.searchParams.delete("cernere_composite_state");
    callbackUrl.searchParams.delete("code");
    window.history.replaceState({}, "", callbackUrl.toString());

    const expectedState = window.sessionStorage.getItem(REDIRECT_STATE_KEY);
    window.sessionStorage.removeItem(REDIRECT_STATE_KEY);
    if (!expectedState || state !== expectedState) {
      onError?.(new Error("ログインの復帰情報を検証できませんでした"));
      return;
    }
    void Promise.resolve(onAuthCode(authCode)).catch((error: unknown) => {
      onError?.(error instanceof Error ? error : new Error("ログイン処理に失敗しました"));
    });
  }, [onAuthCode, onError]);

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

  const startLogin = () => {
    const sameWindow = navigationMode === "same-window"
      || (navigationMode === "auto" && !isMobileBrowser());
    if (!sameWindow) {
      openPopup();
      return;
    }

    try {
      const callbackUrl = new URL(window.location.href);
      callbackUrl.searchParams.delete("code");
      const state = crypto.randomUUID();
      callbackUrl.searchParams.set("cernere_composite_state", state);
      window.sessionStorage.setItem(REDIRECT_STATE_KEY, state);
      const loginUrl = buildCompositePasskeyRedirectLoginUrl(
        cernereUrl,
        callbackUrl.toString(),
      );
      window.location.assign(loginUrl);
    } catch {
      fail(new Error("Cernere URL またはリダイレクト先が不正です"));
    }
  };

  return (
    <button
      type="button"
      className={className}
      disabled={disabled || pending}
      onClick={startLogin}
    >
      {pending ? pendingLabel : buttonLabel}
    </button>
  );
}
