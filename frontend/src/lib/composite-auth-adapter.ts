/**
 * Cernere 自身のフロントが <CompositeLogin> (埋め込み SDK) に渡す authApi 実装。
 *
 * 他サービスは自分の backend → project WS 経由で Cernere を叩くが、Cernere の
 * /login と /composite/login は同一 origin なので REST を直接呼ぶ:
 *   POST /api/auth/passkey/{login-begin, composite-login-finish}
 * finish は authCode を返し、ページ側が self exchange / postMessage / redirect の
 * いずれかで引き渡す。ログインはパスキーのみで、新規作成はページ側 (onCreateAccount) が行う。
 */

import type {
  CompositeAuthApi,
  CompositeAuthResponse,
  PasskeyLoginBeginResult,
} from "@ludiars/cernere-composite/ui";
import type { AuthenticationResponseJSON } from "@simplewebauthn/browser";
import { auth } from "./api";
import { isMobileDevice } from "./device-kind";
import { passkeyEnrollmentUrl, shouldOfferPcEnrollment } from "./passkey-enrollment";

async function postJson<T>(url: string, body: unknown, fallbackError: string): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as T & { error?: string; consentUrl?: string };
  // サービスの権限への同意が要る: この popup のまま /consent を開く。同意後は /consent が
  // 発行時に検証済みの送り先へ authCode を渡す (この画面へは戻らない)。
  if (res.status === 403 && data.error === "consent_required" && data.consentUrl) {
    window.location.assign(data.consentUrl);
    return new Promise<T>(() => { /* 遷移するので解決しない */ });
  }
  if (!res.ok) throw new Error(data.error ?? fallbackError);
  return data;
}

export class CernereCompositeAuthAdapter implements CompositeAuthApi {
  /**
   * @param target popup / redirect の送り先。あればサービス向けの authCode として発行させる
   *   (許可待ちのユーザーには出ない)。self モード (Cernere 自身の /login) は null。
   */
  constructor(
    private readonly apiBase: string = "",
    private readonly target: string | null = null,
    /** target の種類。同意後にどう戻すか (postMessage / redirect) をサーバが決めるのに使う */
    private readonly targetMode: "post_message" | "redirect" = "post_message",
    /** 引き継ぎメニューの ① (別の端末のパスキーで入る)。WebAuthn の hints で QR (hybrid) を先に出させる */
    private readonly crossDevice: boolean = false,
    /** Original local destination, resumed through the normal consent/target checks after enrollment. */
    private readonly enrollmentReturnTo: string | null = null,
  ) {}

  async passkeyLoginBegin(): Promise<PasskeyLoginBeginResult> {
    const begin = await postJson<PasskeyLoginBeginResult>(`${this.apiBase}/api/auth/passkey/login-begin`, {}, "Passkey login start failed");
    if (!this.crossDevice) return begin;
    // hints は WebAuthn Level 3。対応していないブラウザは無視し、通常の選択画面 (別の端末も選べる) を出す。
    return { ...begin, options: { ...begin.options, hints: ["hybrid"] } } as PasskeyLoginBeginResult;
  }

  async passkeyLoginFinish(params: { challengeOwner: string; response: AuthenticationResponseJSON }): Promise<CompositeAuthResponse> {
    const offerEnrollment = this.enrollmentReturnTo !== null
      && shouldOfferPcEnrollment(params.response.authenticatorAttachment, isMobileDevice(), this.enrollmentReturnTo);
    const data = await postJson<{ authCode?: string }>(
      `${this.apiBase}/api/auth/passkey/composite-login-finish`,
      this.target && !offerEnrollment ? { ...params, target: this.target, targetMode: this.targetMode } : params, "Passkey login failed");
    if (!data.authCode) throw new Error("Passkey login failed");
    if (offerEnrollment && this.enrollmentReturnTo !== null) {
      // Obtain only a Cernere session here. Service consent and authorization still run on return.
      await auth.exchangeAuthCode(data.authCode);
      window.location.assign(passkeyEnrollmentUrl(this.enrollmentReturnTo));
      return new Promise<CompositeAuthResponse>(() => { /* Navigation replaces this page; do not deliver a consumed code. */ });
    }
    return { authCode: data.authCode };
  }

  /** ページ unmount 時に呼ぶ。保持する接続は無いが、呼び出し側の寿命管理を変えないため残す。 */
  dispose(): void {}
}
