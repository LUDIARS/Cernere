import { useEffect, useRef, useState } from "react";
import { compositeLoginUrl, createCompositePkce, type CompositeAuthorizationRequest, type CompositePkce } from "./pkce.js";

const DEFAULT_POPUP_FEATURES = "popup,width=480,height=640,resizable=yes,scrollbars=yes";

export interface CompositePasskeyPopupProps {
  cernereUrl: string;
  clientId: string;
  onAuthCode: (authCode: string, codeVerifier: string) => void | Promise<void>;
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
  state: string;
}

export function buildCompositePasskeyLoginUrl(
  cernereUrl: string,
  origin: string,
  request: CompositeAuthorizationRequest,
): string {
  const url = compositeLoginUrl(cernereUrl, request);
  url.searchParams.set("origin", new URL(origin).origin);
  url.searchParams.set("auth_mode", "passkey");
  return url.toString();
}

export function buildCompositePasskeyRedirectLoginUrl(
  cernereUrl: string,
  redirectUri: string,
  request: CompositeAuthorizationRequest,
): string {
  const url = compositeLoginUrl(cernereUrl, request);
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
    && message.authCode.length > 0 && typeof message.state === "string";
}

/**
 * Opens the Cernere-hosted passkey ceremony and returns its one-time auth code.
 * WebAuthn intentionally stays on the Cernere origin so its RP ID remains valid.
 */
export function CompositePasskeyPopup({
  cernereUrl,
  clientId,
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
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; cleanupRef.current?.(); };
  }, []);

  const releaseBusy = () => { busyRef.current = false; if (mountedRef.current) setPending(false); };

  useEffect(() => {
    const callbackUrl = new URL(window.location.href);
    const state = callbackUrl.searchParams.get("state");
    const authCode = callbackUrl.searchParams.get("code");
    if (!state || !authCode) return;

    callbackUrl.searchParams.delete("state");
    callbackUrl.searchParams.delete("code");
    window.history.replaceState({}, "", callbackUrl.toString());

    const raw = window.sessionStorage.getItem(REDIRECT_STATE_KEY);
    window.sessionStorage.removeItem(REDIRECT_STATE_KEY);
    let pendingRequest: (CompositePkce & { clientId: string; createdAt: number }) | null = null;
    try { pendingRequest = raw ? JSON.parse(raw) : null; } catch { /* Invalid local state is rejected below. */ }
    if (!pendingRequest || pendingRequest.clientId !== clientId || state !== pendingRequest.state
      || typeof pendingRequest.codeVerifier !== "string" || !Number.isFinite(pendingRequest.createdAt)
      || Date.now() < pendingRequest.createdAt || Date.now() - pendingRequest.createdAt > timeoutMs) {
      onError?.(new Error("ログインの復帰情報を検証できませんでした"));
      return;
    }
    busyRef.current = true;
    setPending(true);
    void Promise.resolve().then(() => onAuthCode(authCode, pendingRequest.codeVerifier)).catch((error: unknown) => {
      if (mountedRef.current) onError?.(error instanceof Error ? error : new Error("ログイン処理に失敗しました"));
    }).finally(releaseBusy);
  }, [onAuthCode, onError, clientId, timeoutMs]);

  const fail = (error: Error) => {
    releaseBusy();
    if (mountedRef.current) onError?.(error);
  };

  const openPopup = async () => {
    cleanupRef.current?.();

    let loginUrl: string;
    let expectedOrigin: string;
    const popup = window.open("about:blank", popupName, popupFeatures);
    if (!popup) { fail(new Error("ログイン画面を開けませんでした。ポップアップを許可してください")); return; }
    cleanupRef.current = () => popup.close();
    let request: CompositePkce;
    try {
      request = await createCompositePkce();
      if (popup.closed || !mountedRef.current) { popup.close(); releaseBusy(); return; }
      const callerOrigin = origin ?? window.location.origin;
      loginUrl = buildCompositePasskeyLoginUrl(cernereUrl, callerOrigin, { ...request, clientId });
      expectedOrigin = new URL(cernereUrl).origin;
    } catch {
      popup.close();
      fail(new Error("Cernere URL または呼び出し元 origin が不正です"));
      return;
    }

    popup.location.replace(loginUrl);

    setPending(true);
    let settled = false;
    const cleanup = () => {
      window.removeEventListener("message", handleMessage);
      window.clearInterval(closeTimer);
      window.clearTimeout(timeoutTimer);
      popup.close();
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
        || !isCernereAuthMessage(event.data) || event.data.state !== request.state) {
        return;
      }
      settled = true;
      cleanup();
      popup.close();
      const authCode = event.data.authCode;
      void Promise.resolve().then(() => onAuthCode(authCode, request.codeVerifier)).catch((error: unknown) => {
        fail(error instanceof Error ? error : new Error("ログイン処理に失敗しました"));
      }).finally(releaseBusy);
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

  const startLogin = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPending(true);
    const sameWindow = navigationMode === "same-window"
      || (navigationMode === "auto" && !isMobileBrowser());
    if (!sameWindow) {
      try { await openPopup(); }
      catch (error) {
        cleanupRef.current?.();
        fail(error instanceof Error ? error : new Error("ログインを開始できませんでした"));
      }
      return;
    }

    try {
      const callbackUrl = new URL(window.location.href);
      callbackUrl.searchParams.delete("code");
      callbackUrl.searchParams.delete("state");
      const request = await createCompositePkce();
      if (!mountedRef.current) { releaseBusy(); return; }
      window.sessionStorage.setItem(REDIRECT_STATE_KEY, JSON.stringify({ ...request, clientId, createdAt: Date.now() }));
      const loginUrl = buildCompositePasskeyRedirectLoginUrl(
        cernereUrl,
        callbackUrl.toString(),
        { ...request, clientId },
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
