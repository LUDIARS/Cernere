/**
 * Cernere 自身の /login・/composite/login が <CompositeLogin> に渡す日本語文言。
 * SDK の既定 (英語) のうち、 利用者に見える説明系だけを上書きする。
 */

import type { CompositeLoginLabels } from "@ludiars/cernere-composite/ui";

export const CERNERE_LOGIN_LABELS: Partial<CompositeLoginLabels> = {
  title: "Cernere",
  subtitle: "Sign in to continue",
  subtitlePasskeyOnly: "Passkey でログイン",
  loginTab: "Login",
  registerTab: "Register",
  name: "Name",
  emailOptional: "Email（任意 — パスワード登録では必須）",
  passwordOptional: "Password（パスワード登録を使う場合のみ）",
  submitRegisterPassword: "パスワードでアカウント作成",
  orUsePassword: "またはパスワードで",
  passkeyLogin: "🔐 Passkey でログイン（生体認証 / Windows Hello PIN / セキュリティキー）",
  passkeyRetry: "🔐 もう一度 Passkey でログイン",
  passkeyRunning: "認証器の応答を待っています…",
  passkeyUnsupported: "このブラウザはパスキー (WebAuthn) に対応していません。対応ブラウザで開き直してください。",
  passkeyUnsupportedFallback: "このブラウザはパスキー (WebAuthn) に対応していません。メールとパスワードでログインしてください。",
  passkeyFallback: "使えるパスキーが見つからないか、認証をキャンセルしました。もう一度ボタンを押してください。",
  passkeyFallbackWithForm: "使えるパスキーが見つからないか、認証をキャンセルしました。下のフォームでログインするか、もう一度ボタンを押してください。",
  passkeySignup: "🔐 パスキーでアカウント作成",
  passkeySignupHint: "メールアドレス・パスワード不要。端末の生体認証 / PIN がそのままログイン手段になります。",
  nameRequired: "名前を入力してください",
  registerPasswordRequires: "パスワード登録にはメールアドレスとパスワードが必要です (パスキーなら名前だけで登録できます)",
  alreadyHaveAccount: "既にアカウントをお持ちの方はログイン",
  noAccountYet: "アカウントをお持ちでない方は新規登録",
  deviceTitle: "本人確認が必要です",
  deviceSubtitle: "{email} に確認コードを送信しました。",
  deviceCode: "確認コード",
  deviceSubmit: "確認コードを検証",
  deviceResend: "確認コードを再送",
  deviceResent: "確認コードを再送しました。",
  collectingFingerprint: "デバイス情報を収集中...",
  anomalyNewDevice: "新しいデバイス",
  anomalyNewOs: "新しい OS",
  anomalyNewBrowser: "新しいブラウザ",
  anomalyNewIp: "普段と異なるネットワーク",
  anomalyMissing: "デバイス情報を取得できませんでした",
  remainingAttempts: "残り {n} 回",
};
