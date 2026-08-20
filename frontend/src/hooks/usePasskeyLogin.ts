/**
 * パスキー (WebAuthn) ログインの ceremony を 1 箇所に集めた hook。
 *
 * ログイン画面を開いた直後に Windows Hello / Face ID を「そのまま」開くのが主用途。
 * メールを渡さない usernameless (discoverable credential) で login-begin を叩くため、
 * ユーザはメール入力もボタン押下も踏まずに端末の PIN / 生体ダイアログへ入る。
 *
 * ceremony:
 *   1. POST /api/auth/passkey/login-begin        → options (allowCredentials 空 = usernameless)
 *   2. navigator.credentials.get() (startAuthentication)
 *   3. POST /api/auth/passkey/composite-login-finish → authCode
 *
 * 自動起動は 1 マウントにつき 1 回だけ。 キャンセル / 未登録は「失敗」ではなく
 * fallback として扱い、 呼び出し側は現在の auth mode で許可された明示導線を出す。
 *
 * @implements SPEC-COMPOSITE-PASSKEY-AUTOSTART
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  startAuthentication,
  browserSupportsWebAuthn,
  type PublicKeyCredentialRequestOptionsJSON,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/browser";

export type PasskeyLoginPhase =
  /** 未実行 (自動起動待ち、 または fallback 後の待機) */
  | "idle"
  /** 認証器ダイアログを開いている最中 */
  | "running"
  /** このブラウザが WebAuthn 非対応 */
  | "unsupported"
  /** 自動起動したがキャンセル / 未登録だった — auth mode が許可する明示導線へ */
  | "fallback";

interface UsePasskeyLoginArgs {
  apiBase: string;
  /**
   * 自動起動して良い状態か。 composite モードでは送信先検証と silent SSO の決着後に
   * true を渡す (先に authCode が取れる場合に認証器ダイアログを開かせないため)。
   */
  autoStartReady: boolean;
  /** ceremony が authCode まで到達したとき */
  onAuthCode: (authCode: string) => void;
  /** 利用者取消 / credential 不在以外の明確な失敗 */
  onError: (message: string) => void;
}

interface UsePasskeyLoginResult {
  phase: PasskeyLoginPhase;
  /** 一度でも自動起動を試したか (ボタン文言の切替に使う) */
  autoAttempted: boolean;
  /** 手動起動。 email を渡すとそのユーザの credential に絞る (未指定は usernameless) */
  start: (email?: string) => void;
}

/**
 * ユーザがダイアログを閉じた / 候補が無かった場合。 これは「エラー」ではない。
 *
 * @implements SPEC-COMPOSITE-PASSKEY-AUTOSTART
 */
function isUserAbort(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "NotAllowedError" || err.name === "AbortError";
}

/** @implements SPEC-COMPOSITE-PASSKEY-AUTOSTART */
export function usePasskeyLogin({
  apiBase,
  autoStartReady,
  onAuthCode,
  onError,
}: UsePasskeyLoginArgs): UsePasskeyLoginResult {
  const [phase, setPhase] = useState<PasskeyLoginPhase>("idle");
  const [autoAttempted, setAutoAttempted] = useState(false);
  const autoStartedRef = useRef(false);
  const inFlightRef = useRef(false);
  /** アンマウント後の setState を避ける */
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // 最新の callback を掴む (effect の依存に入れて再発火させないため)
  const onAuthCodeRef = useRef(onAuthCode);
  const onErrorRef = useRef(onError);
  onAuthCodeRef.current = onAuthCode;
  onErrorRef.current = onError;

  const run = useCallback(async (email: string): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPhase("running");
    try {
      const beginRes = await fetch(`${apiBase}/api/auth/passkey/login-begin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const beginData = await beginRes.json() as {
        options: PublicKeyCredentialRequestOptionsJSON;
        challengeOwner: string;
        error?: string;
      };
      if (!beginRes.ok) throw new Error(beginData.error || "Passkey login start failed");

      const assertion: AuthenticationResponseJSON =
        await startAuthentication({ optionsJSON: beginData.options });

      const finishRes = await fetch(`${apiBase}/api/auth/passkey/composite-login-finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: assertion, challengeOwner: beginData.challengeOwner }),
      });
      const finishData = await finishRes.json() as { authCode?: string; error?: string };
      if (!finishRes.ok || !finishData.authCode) {
        throw new Error(finishData.error || "Passkey login failed");
      }
      if (!aliveRef.current) return;
      // authCode の引き渡し後も画面に留まる場合 (self exchange 失敗等) に、
      // 再試行ボタンを permanently disabled にしない。
      setPhase("idle");
      onAuthCodeRef.current(finishData.authCode);
    } catch (err: unknown) {
      if (!aliveRef.current) return;
      setPhase("fallback");
      // 利用者取消 / credential 不在だけを静かに明示導線へ戻す。
      // 通信・サーバ障害まで隠すと「パスキーが無い」と誤案内するため、起動方法を問わず表示する。
      if (isUserAbort(err)) return;
      onErrorRef.current(err instanceof Error ? err.message : "Passkey login failed");
    } finally {
      inFlightRef.current = false;
    }
  }, [apiBase]);

  // ── ログイン画面を開いた直後に認証器ダイアログを開く (1 マウント 1 回) ──
  useEffect(() => {
    if (!autoStartReady || autoStartedRef.current) return;
    autoStartedRef.current = true;
    setAutoAttempted(true);
    if (!browserSupportsWebAuthn()) {
      setPhase("unsupported");
      return;
    }
    void run("");
  }, [autoStartReady, run]);

  const start = useCallback((email?: string) => {
    // 手動起動も 1 回きりの自動起動枠を消費済みにしておく (二重発火防止)
    autoStartedRef.current = true;
    if (!browserSupportsWebAuthn()) {
      setPhase("unsupported");
      return;
    }
    void run(email?.trim() ?? "");
  }, [run]);

  return { phase, autoAttempted, start };
}
