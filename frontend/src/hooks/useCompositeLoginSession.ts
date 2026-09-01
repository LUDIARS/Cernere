/**
 * <CompositeLoginPage> のセッション周りをまとめた hook。
 *
 *   - 認証通信 adapter (REST + composite WS) の生成と unmount 時の破棄
 *   - 送信先 (origin / redirect_uri) のサーバ許可リスト検証 (fail-closed)
 *   - silent SSO (Cernere ログイン済みなら対話なしで authCode を発行)
 *   - authCode の引き渡し (CompositeAuthHandoff)
 *   - パスキー自動起動を許可してよいタイミングの決定
 *
 * ページ側は戻り値を <CompositeLogin> に渡して描画するだけにする。
 */

import { useEffect, useMemo, useState } from "react";
import { auth as authApi, getAccessToken, hasAccessRecord } from "../lib/api";
import { CernereCompositeAuthAdapter } from "../lib/composite-auth-adapter";
import { CompositeAuthHandoff } from "../lib/composite-auth-handoff";
import { fetchAllowedOrigins, isTargetAllowed } from "../lib/composite-redirect";

export interface CompositeLoginSessionArgs {
  /** Cernere 単独フロントの /login (authCode を自分のトークンに交換) */
  self: boolean;
  /** popup モードの postMessage 送信先 (URL クエリ由来) */
  origin: string | null;
  /** redirect モードの遷移先 (URL クエリ由来) */
  redirectUri: string | null;
  /** self モードの戻り先 (`?redirect=`) */
  redirectParam: string | null;
  /** `?mode=` の生値 */
  modeParam: string | null;
  apiBase: string;
}

export interface CompositeLoginSession {
  adapter: CernereCompositeAuthAdapter;
  /** 初期タブ。 ?mode= 最優先、 self の初訪問は register */
  initialMode: "login" | "register";
  /** 送信先が許可外 / 未指定のときの停止理由。 立っている間はログイン UI を出さない */
  blockedReason: string;
  /** authCode 引き渡し段階 (self exchange 等) の失敗 */
  handoffError: string;
  /** パスキー ceremony を自動起動してよいか (送信先検証と silent SSO の決着後) */
  passkeyAutoReady: boolean;
  /** 認証成功時に呼ぶ。 引き渡し先は URL から決まる */
  deliver: (authCode: string) => void;
}

const TARGET_CHECK_PENDING = "送信先を確認しています…";

/**
 * 初期タブ: ?mode= が最優先。 self では「アクセスした形跡」が無い初訪問に Register を優先 (#149)。
 * @implements SPEC-COMPOSITE-AUTHCODE-HANDOFF
 */
export function resolveInitialLoginMode(modeParam: string | null, self: boolean): "login" | "register" {
  if (modeParam === "register" || modeParam === "login") return modeParam;
  if (self && !hasAccessRecord()) return "register";
  return "login";
}

/**
 * @implements SPEC-COMPOSITE-AUTHCODE-HANDOFF
 * @implements SPEC-COMPOSITE-PASSKEY-AUTOSTART
 */
export function useCompositeLoginSession(args: CompositeLoginSessionArgs): CompositeLoginSession {
  const { self, origin, redirectUri, redirectParam, modeParam, apiBase } = args;

  // composite は検証開始前も fail-closed。空文字にしておくと最初の effect が完了するまで
  // 認証 UI が一瞬描画され、資格情報や手動 passkey を送信できてしまう。
  const [blockedReason, setBlockedReason] = useState(self ? "" : TARGET_CHECK_PENDING);
  const [handoffError, setHandoffError] = useState("");
  // self は即座に、 composite は送信先検証と silent SSO が「authCode を取れなかった」と
  // 決着してから true にする (ダイアログの空振り防止)。
  const [passkeyAutoReady, setPasskeyAutoReady] = useState(self);

  const initialMode = useMemo(() => resolveInitialLoginMode(modeParam, self), [modeParam, self]);

  // adapter は WS を抱えるので、 ページと同じ寿命で 1 つだけ持ち unmount で閉じる。
  const adapter = useMemo(() => new CernereCompositeAuthAdapter(apiBase), [apiBase]);
  useEffect(() => () => adapter.dispose(), [adapter]);

  // 引き渡し先は URL 由来で描画中に変わらない。
  const handoff = useMemo(() => new CompositeAuthHandoff({
    self,
    origin,
    redirectUri,
    redirectParam,
    exchange: (code) => authApi.exchangeAuthCode(code),
    onError: setHandoffError,
  }), [self, origin, redirectUri, redirectParam]);

  // ── 送信先 (origin / redirect_uri) をサーバ許可リストで事前検証 (VULNWEB-001) ──
  // 不正な送信先ならログイン UI を出す前に停止し、 authCode を発行させない。
  useEffect(() => {
    if (self) {
      setBlockedReason("");
      return; // self モードは送信先検証も silent SSO も不要 (App 側でログイン済みを弾く)
    }
    let cancelled = false;
    setBlockedReason(TARGET_CHECK_PENDING);
    setPasskeyAutoReady(false);
    void (async () => {
      const allowed = await fetchAllowedOrigins();
      if (cancelled) return;
      handoff.setAllowedOrigins(allowed);
      const target = origin ?? redirectUri;
      if (!target) {
        setBlockedReason("送信先が指定されていません (origin / redirect_uri が必要です)。");
        return;
      }
      if (!isTargetAllowed(target, allowed)) {
        setBlockedReason("許可されていない送信先です。この画面は安全に続行できません。");
        return;
      }
      // silent SSO — 既に Cernere ログイン済み (accessToken 保持) なら、 passkey/
      // パスワードの再入力なしで authCode を発行し、 呼び出し元 (EducationLab 等) へ返す。
      // 失敗 / 未ログインなら通常の対話ログイン UI にフォールバックする。
      const token = getAccessToken();
      if (token) {
        try {
          const res = await fetch(`${apiBase}/api/auth/composite-session-code`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({ target }),
          });
          if (!cancelled && res.ok) {
            const body = await res.json().catch(() => null) as { authCode?: string } | null;
            if (body?.authCode) { handoff.deliver(body.authCode); return; }
          }
        } catch {
          /* 対話フローにフォールバック */
        }
      }
      // silent SSO では入れなかった → 対話ログイン。 ここで初めて認証器を開いてよい。
      if (!cancelled) {
        setBlockedReason("");
        setPasskeyAutoReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [self, origin, redirectUri, apiBase, handoff]);

  /** @implements SPEC-COMPOSITE-AUTHCODE-HANDOFF */
  const deliver = (authCode: string): void => {
    setHandoffError("");
    handoff.deliver(authCode);
  };

  return { adapter, initialMode, blockedReason, handoffError, passkeyAutoReady, deliver };
}
