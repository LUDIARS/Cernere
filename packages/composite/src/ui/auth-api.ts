/**
 * <CompositeLogin> が利用側から受け取る認証 API の契約。
 *
 * カードは実通信を持たない。 サービス SPA は自分の backend (→ project WS → Cernere)
 * へ中継する実装を渡す。 Cernere 自身のフロントは REST / composite WS を直接叩く
 * adapter を渡す (frontend/src/lib/composite-auth-adapter.ts)。
 *
 * passkey 4 メソッドは「全部あるか、全部無いか」。 一部だけ渡す構成は設定不備として
 * 起動時に fail-fast させる (passkeyApiOf)。
 */

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import type { DeviceFingerprint } from "./device-fingerprint.js";

export type DeviceAnomaly =
  | "new_device"
  | "new_os"
  | "new_browser"
  | "new_ip"
  | "missing_fingerprint";

export interface CompositeAuthResponse {
  authCode?: string;
  mfaRequired?: boolean;
  mfaMethods?: string[];
  mfaToken?: string;
  /** 本人確認 (デバイス検証) が必要 */
  deviceVerificationRequired?: boolean;
  deviceToken?: string;
  /** 確認コード送信先のマスクされたメール (例: u***@example.com) */
  emailMasked?: string;
  /** 検出された差分の一覧 */
  anomalies?: DeviceAnomaly[];
  /** 確認コードの送信チャネル */
  codeChannel?: "email" | "console";
  /** デバイスラベル (例: "macOS · Chrome 124 · Tokyo, JP") */
  deviceLabel?: string;
  /** 残り試行回数 (失敗応答時) */
  remainingAttempts?: number;
  error?: string;
}

/** `passkey-login-begin` の応答 (Cernere REST / project WS 共通の形) */
export interface PasskeyLoginBeginResult {
  options: PublicKeyCredentialRequestOptionsJSON;
  challengeOwner: string;
}

/** `passkey-signup-begin` の応答 */
export interface PasskeySignupBeginResult {
  signupId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
}

/**
 * パスキー ceremony の 4 段。 WebAuthn の呼び出し自体 (navigator.credentials) は
 * カード側が行うので、 利用側は begin/finish を Cernere へ往復させるだけでよい。
 * finish は通常ログインと同じ CompositeAuthResponse (authCode) を返す。
 */
export interface CompositePasskeyApi {
  /** email を渡すとそのユーザの credential に絞る。 未指定は usernameless */
  passkeyLoginBegin(params: { email?: string }): Promise<PasskeyLoginBeginResult>;
  passkeyLoginFinish(params: {
    challengeOwner: string;
    response: AuthenticationResponseJSON;
  }): Promise<CompositeAuthResponse>;
  /** メールアドレス不要のアカウント作成 (name のみ必須) */
  passkeySignupBegin(params: { name: string; email?: string }): Promise<PasskeySignupBeginResult>;
  passkeySignupFinish(params: {
    signupId: string;
    response: RegistrationResponseJSON;
  }): Promise<CompositeAuthResponse>;
}

export interface CompositeAuthApi extends Partial<CompositePasskeyApi> {
  /** Email / パスワードでログイン (device は本人確認用フィンガープリント) */
  login(params: { email: string; password: string; device?: DeviceFingerprint }): Promise<CompositeAuthResponse>;
  /**
   * パスワードで新規ユーザー登録。 パスキー登録は passkeySignup* を使うため、
   * こちらは email + password を揃えた場合だけカードから呼ばれる。
   */
  register(params: { name: string; email?: string; password?: string; device?: DeviceFingerprint }): Promise<CompositeAuthResponse>;
  /** MFA チャレンジ応答 (任意) */
  mfaVerify?(params: { mfaToken: string; method: string; code: string; device?: DeviceFingerprint }): Promise<CompositeAuthResponse>;
  /** 登録済みメールへ MFA コードを送信・再送する。 */
  mfaSendCode?(params: { mfaToken: string; method: string }): Promise<void>;
  /** デバイス本人確認: 確認コードを検証し authCode を取得する */
  deviceVerify?(params: { deviceToken: string; code: string }): Promise<CompositeAuthResponse>;
  /** 確認コードを再送する */
  deviceResend?(params: { deviceToken: string }): Promise<CompositeAuthResponse>;
}

const PASSKEY_METHODS = [
  "passkeyLoginBegin",
  "passkeyLoginFinish",
  "passkeySignupBegin",
  "passkeySignupFinish",
] as const satisfies readonly (keyof CompositePasskeyApi)[];

/**
 * authApi からパスキー API を取り出す。 4 メソッド全て無ければ null (パスキー導線を
 * 出さない)。 一部だけある場合は設定不備なので即エラー — 途中で undefined を呼んで
 * 「ダイアログが出ない」 という無言故障にしない。
 */
export function passkeyApiOf(api: CompositeAuthApi): CompositePasskeyApi | null {
  const present = PASSKEY_METHODS.filter((m) => typeof api[m] === "function");
  if (present.length === 0) return null;
  if (present.length !== PASSKEY_METHODS.length) {
    const missing = PASSKEY_METHODS.filter((m) => !present.includes(m));
    throw new Error(
      `CompositeLogin: authApi passkey methods are incomplete (missing: ${missing.join(", ")})`,
    );
  }
  return {
    passkeyLoginBegin: (p) => api.passkeyLoginBegin!(p),
    passkeyLoginFinish: (p) => api.passkeyLoginFinish!(p),
    passkeySignupBegin: (p) => api.passkeySignupBegin!(p),
    passkeySignupFinish: (p) => api.passkeySignupFinish!(p),
  };
}
