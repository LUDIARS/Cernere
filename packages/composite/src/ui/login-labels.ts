/**
 * <CompositeLogin> の表示文言。 利用側は `labels` prop で部分上書きできる (i18n)。
 * 既定は英語。 Cernere 自身のフロントは日本語を渡す。
 */

export interface CompositeLoginLabels {
  title: string;
  subtitle: string;
  /** passkeyOnly のときの副題 */
  subtitlePasskeyOnly: string;
  loginTab: string;
  registerTab: string;
  name: string;
  email: string;
  /** パスキー導線があるときの Email 欄 (任意入力) */
  emailOptional: string;
  password: string;
  /** パスキー導線があるときの Password 欄 (パスワード登録時のみ) */
  passwordOptional: string;
  submitLogin: string;
  submitRegister: string;
  /** パスキー導線があるときのパスワード登録ボタン */
  submitRegisterPassword: string;
  processing: string;
  orContinueWith: string;
  /** register タブでパスキー登録とパスワード登録を隔てる区切り */
  orUsePassword: string;
  continueWithGoogle: string;
  continueWithGithub: string;
  mfaTitle: string;
  mfaCode: string;
  submitMfa: string;
  mfaMethod: string;
  mfaTotp: string;
  mfaEmail: string;
  mfaSend: string;
  mfaSent: string;
  mfaHint: string;
  mfaCancel: string;
  // ── パスキー ──────────────────
  passkeyLogin: string;
  passkeyRetry: string;
  passkeyRunning: string;
  passkeyUnsupported: string;
  passkeyUnsupportedFallback: string;
  passkeyFallback: string;
  passkeyFallbackWithForm: string;
  passkeySignup: string;
  passkeySignupHint: string;
  nameRequired: string;
  registerPasswordRequires: string;
  alreadyHaveAccount: string;
  noAccountYet: string;
  // ── デバイス本人確認 ──────────────
  deviceTitle: string;
  deviceSubtitle: string;
  deviceCode: string;
  deviceCodePlaceholder: string;
  deviceSubmit: string;
  deviceResend: string;
  deviceResent: string;
  collectingFingerprint: string;
  anomalyNewDevice: string;
  anomalyNewOs: string;
  anomalyNewBrowser: string;
  anomalyNewIp: string;
  anomalyMissing: string;
  remainingAttempts: string;
}

export const DEFAULT_LABELS: CompositeLoginLabels = {
  title: "Cernere",
  subtitle: "Sign in to continue",
  subtitlePasskeyOnly: "Sign in with your passkey",
  loginTab: "Login",
  registerTab: "Register",
  name: "Name",
  email: "Email",
  emailOptional: "Email (optional — required only for password sign-up)",
  password: "Password",
  passwordOptional: "Password (only if you sign up with a password)",
  submitLogin: "Login",
  submitRegister: "Create Account",
  submitRegisterPassword: "Create account with password",
  processing: "Processing...",
  orContinueWith: "or",
  orUsePassword: "or use a password",
  continueWithGoogle: "Continue with Google",
  continueWithGithub: "Continue with GitHub",
  mfaTitle: "MFA Verification",
  mfaCode: "Code",
  submitMfa: "Verify",
  mfaMethod: "Verification method",
  mfaTotp: "Authenticator app",
  mfaEmail: "Email",
  mfaSend: "Send / resend email code",
  mfaSent: "Code sent to your registered email. Wait 60 seconds before resending.",
  mfaHint: "Enter the 6-digit code within 5 minutes. Each Authenticator code can be used only once.",
  mfaCancel: "Start again",
  passkeyLogin: "🔐 Sign in with passkey (biometrics / Windows Hello PIN / security key)",
  passkeyRetry: "🔐 Try passkey again",
  passkeyRunning: "Waiting for your authenticator...",
  passkeyUnsupported: "This browser does not support passkeys (WebAuthn).",
  passkeyUnsupportedFallback: "This browser does not support passkeys (WebAuthn). Sign in with email and password.",
  passkeyFallback: "No usable passkey was found or the prompt was cancelled. Press the button to try again.",
  passkeyFallbackWithForm: "No usable passkey was found or the prompt was cancelled. Sign in below or try again.",
  passkeySignup: "🔐 Create account with passkey",
  passkeySignupHint: "No email or password needed — your device's biometrics or PIN becomes your sign-in.",
  nameRequired: "Please enter a name.",
  registerPasswordRequires: "Password sign-up needs both email and password (passkey sign-up needs only a name).",
  alreadyHaveAccount: "Already have an account? Sign in",
  noAccountYet: "No account yet? Register",
  deviceTitle: "Verify it's you",
  deviceSubtitle: "We sent a 6-digit verification code to {email}.",
  deviceCode: "Verification code",
  deviceCodePlaceholder: "123456",
  deviceSubmit: "Verify device",
  deviceResend: "Resend code",
  deviceResent: "Code re-sent.",
  collectingFingerprint: "Collecting device information...",
  anomalyNewDevice: "New device",
  anomalyNewOs: "New OS",
  anomalyNewBrowser: "New browser",
  anomalyNewIp: "Different network",
  anomalyMissing: "Could not collect device information",
  remainingAttempts: "{n} attempts remaining",
};
