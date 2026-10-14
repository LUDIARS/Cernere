/**
 * <CompositeLogin> が利用側から受け取る認証 API の契約。
 *
 * ログインはパスキーのみ。カードは WebAuthn (navigator.credentials) を自分で呼び、
 * 利用側は begin/finish を Cernere へ往復させるだけ。サービス SPA は自分の backend
 * (→ project WS → Cernere) へ中継する実装を、Cernere 自身のフロントは REST を直接叩く
 * adapter を渡す (frontend/src/lib/composite-auth-adapter.ts)。
 *
 * 新規作成はカードでは行わない。名前・リカバリー QR・別端末の追加を Cernere の画面で
 * 済ませるため、利用側の onCreateAccount から Cernere の popup を開く (CompositePasskeyPopup)。
 */

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

export interface CompositeAuthResponse {
  authCode?: string;
  error?: string;
}

/** `passkey-login-begin` の応答 (Cernere REST / project WS 共通の形) */
export interface PasskeyLoginBeginResult {
  options: PublicKeyCredentialRequestOptionsJSON;
  challengeOwner: string;
}

export interface CompositeAuthApi {
  /** usernameless (discoverable credential) のログイン開始 */
  passkeyLoginBegin(params: Record<string, never>): Promise<PasskeyLoginBeginResult>;
  passkeyLoginFinish(params: {
    challengeOwner: string;
    response: AuthenticationResponseJSON;
  }): Promise<CompositeAuthResponse>;
}
