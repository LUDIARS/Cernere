/**
 * <CompositeLogin> の表示文言。 利用側は `labels` prop で部分上書きできる (i18n)。
 * 既定は英語。 Cernere 自身のフロントは日本語を渡す。
 *
 * ログインはパスキーのみ (spec/plan/2026-10-14-passkey-only-authentication.md)。
 * 登録とログインを区別せず「パスキーで続ける」1 つで始める。
 */

export interface CompositeLoginLabels {
  title: string;
  subtitle: string;
  processing: string;
  orContinueWith: string;
  /** 主ボタン (初回) */
  passkeyContinue: string;
  /** 主ボタン (取消・失敗の後) */
  passkeyRetry: string;
  passkeyRunning: string;
  passkeyUnsupported: string;
  /** 取消・パスキーが見つからなかったとき。「アカウントが無い」とは言わない */
  passkeyNotCompleted: string;
  /** 他の端末にパスキーがある人への案内 */
  otherDeviceTitle: string;
  otherDeviceHint: string;
  /** リカバリー QR で戻すリンク */
  recoverWithQr: string;
  /** 新規作成 (最下段) */
  createAccount: string;
  createAccountHint: string;
}

export const DEFAULT_LABELS: CompositeLoginLabels = {
  title: "Cernere",
  subtitle: "Continue with your passkey",
  processing: "Processing...",
  orContinueWith: "or",
  passkeyContinue: "🔐 Continue with passkey",
  passkeyRetry: "🔐 Try again",
  passkeyRunning: "Waiting for your authenticator...",
  passkeyUnsupported: "This browser does not support passkeys (WebAuthn). Use another browser or device.",
  passkeyNotCompleted: "Sign-in was not completed. The prompt may have been cancelled, or this device has no passkey for Cernere.",
  otherDeviceTitle: "Your passkey is on another device?",
  otherDeviceHint: "Try again and choose \"use a phone or another device\" in the browser prompt, then scan the QR code with that device.",
  recoverWithQr: "Lost all your devices? Recover with your recovery QR",
  createAccount: "Start a new account",
  createAccountHint: "Only if you have never used Cernere. A new passkey is created on this device.",
};
