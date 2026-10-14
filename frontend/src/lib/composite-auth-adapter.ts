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

async function postJson<T>(url: string, body: unknown, fallbackError: string): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? fallbackError);
  return data;
}

export class CernereCompositeAuthAdapter implements CompositeAuthApi {
  constructor(private readonly apiBase: string = "") {}

  passkeyLoginBegin(): Promise<PasskeyLoginBeginResult> {
    return postJson(`${this.apiBase}/api/auth/passkey/login-begin`, {}, "Passkey login start failed");
  }

  async passkeyLoginFinish(params: { challengeOwner: string; response: AuthenticationResponseJSON }): Promise<CompositeAuthResponse> {
    const data = await postJson<{ authCode?: string }>(
      `${this.apiBase}/api/auth/passkey/composite-login-finish`, params, "Passkey login failed");
    if (!data.authCode) throw new Error("Passkey login failed");
    return { authCode: data.authCode };
  }

  /** ページ unmount 時に呼ぶ。保持する接続は無いが、呼び出し側の寿命管理を変えないため残す。 */
  dispose(): void {}
}
