/**
 * パスキー (WebAuthn) ログインの ceremony を 1 箇所に集めた hook。
 *
 * ログイン画面を開いた直後に Windows Hello / Face ID を「そのまま」開くのが主用途。
 * メールを渡さない usernameless (discoverable credential) で begin を叩くため、
 * ユーザはメール入力もボタン押下も踏まずに端末の PIN / 生体ダイアログへ入る。
 *
 * ceremony:
 *   1. api.passkeyLoginBegin({ email })   → options (allowCredentials 空 = usernameless)
 *   2. navigator.credentials.get()        (startAuthentication)
 *   3. api.passkeyLoginFinish({ ... })    → CompositeAuthResponse (authCode)
 *
 * 通信は利用側の CompositePasskeyApi に委譲する (サービス backend → project WS →
 * Cernere、 または Cernere 自身の REST)。 自動起動は 1 マウントにつき 1 回だけ。
 * キャンセル / 未登録は「失敗」ではなく fallback として扱い、 呼び出し側は現在の
 * auth mode で許可された明示導線を出す。
 *
 * @implements SPEC-COMPOSITE-PASSKEY-AUTOSTART
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  startAuthentication,
  browserSupportsWebAuthn,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/browser";
import type { CompositeAuthResponse, CompositePasskeyApi } from "./auth-api.js";

export type PasskeyLoginPhase =
  /** 未実行 (自動起動待ち、 または fallback 後の待機) */
  | "idle"
  /** 認証器ダイアログを開いている最中 */
  | "running"
  /** このブラウザが WebAuthn 非対応 */
  | "unsupported"
  /** 自動起動したがキャンセル / 未登録だった — auth mode が許可する明示導線へ */
  | "fallback";

export interface UsePasskeyLoginArgs {
  /** null のときは何もしない (利用側がパスキー API を渡していない) */
  api: CompositePasskeyApi | null;
  /**
   * 自動起動して良い状態か。 composite ページでは送信先検証と silent SSO の決着後に
   * true を渡す (先に authCode が取れる場合に認証器ダイアログを開かせないため)。
   */
  autoStartReady: boolean;
  /** ceremony が finish の応答まで到達したとき (authCode / MFA / device 検証のいずれか) */
  onResponse: (response: CompositeAuthResponse) => void;
  /** 利用者取消 / credential 不在以外の明確な失敗 */
  onError: (message: string) => void;
}

export interface UsePasskeyLoginResult {
  phase: PasskeyLoginPhase;
  /** 自動・手動を問わず、一度でも認証起動を試したか (ボタン文言の切替に使う) */
  hasAttempted: boolean;
  /** 手動起動。 email を渡すとそのユーザの credential に絞る (未指定は usernameless) */
  start: (email?: string) => void;
}

/**
 * ユーザがダイアログを閉じた / 候補が無かった場合。 これは「エラー」ではない。
 *
 * @implements SPEC-COMPOSITE-PASSKEY-AUTOSTART
 */
export function isPasskeyUserAbort(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "NotAllowedError" || err.name === "AbortError";
}

/** @implements SPEC-COMPOSITE-PASSKEY-AUTOSTART */
export function usePasskeyLogin({
  api,
  autoStartReady,
  onResponse,
  onError,
}: UsePasskeyLoginArgs): UsePasskeyLoginResult {
  const [phase, setPhase] = useState<PasskeyLoginPhase>("idle");
  const [hasAttempted, setHasAttempted] = useState(false);
  const autoStartedRef = useRef(false);
  const inFlightRef = useRef(false);
  /** アンマウント後の setState を避ける */
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // 最新の callback を掴む (effect の依存に入れて再発火させないため)
  const onResponseRef = useRef(onResponse);
  const onErrorRef = useRef(onError);
  onResponseRef.current = onResponse;
  onErrorRef.current = onError;

  const run = useCallback(async (email: string): Promise<void> => {
    if (!api || inFlightRef.current) return;
    inFlightRef.current = true;
    setPhase("running");
    try {
      const begin = await api.passkeyLoginBegin(email ? { email } : {});
      const assertion: AuthenticationResponseJSON =
        await startAuthentication({ optionsJSON: begin.options });
      const finish = await api.passkeyLoginFinish({
        challengeOwner: begin.challengeOwner,
        response: assertion,
      });
      if (finish.error) throw new Error(finish.error);
      if (!aliveRef.current) return;
      // authCode の引き渡し後も画面に留まる場合 (exchange 失敗等) に、
      // 再試行ボタンを permanently disabled にしない。
      setPhase("idle");
      onResponseRef.current(finish);
    } catch (err: unknown) {
      if (!aliveRef.current) return;
      setPhase("fallback");
      // 利用者取消 / credential 不在だけを静かに明示導線へ戻す。
      // 通信・サーバ障害まで隠すと「パスキーが無い」と誤案内するため、起動方法を問わず表示する。
      if (isPasskeyUserAbort(err)) return;
      onErrorRef.current(err instanceof Error ? err.message : "Passkey login failed");
    } finally {
      inFlightRef.current = false;
    }
  }, [api]);

  // ── ログイン画面を開いた直後に認証器ダイアログを開く (1 マウント 1 回) ──
  useEffect(() => {
    if (!api || !autoStartReady || autoStartedRef.current) return;
    autoStartedRef.current = true;
    setHasAttempted(true);
    if (!browserSupportsWebAuthn()) {
      setPhase("unsupported");
      return;
    }
    void run("");
  }, [api, autoStartReady, run]);

  const start = useCallback((email?: string) => {
    if (!api) return;
    // 手動起動も 1 回きりの自動起動枠を消費済みにしておく (二重発火防止)。
    // hasAttempted も揃えて立てる — これを落とすと、 自動起動が走る前に手動で
    // 押した場合に autoStartReady が後から true になっても自動起動は抑止され、
    // ボタン文言だけ初回表記のまま残る。
    autoStartedRef.current = true;
    setHasAttempted(true);
    if (!browserSupportsWebAuthn()) {
      setPhase("unsupported");
      return;
    }
    void run(email?.trim() ?? "");
  }, [api, run]);

  return { phase, hasAttempted, start };
}
