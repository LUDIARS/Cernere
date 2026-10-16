/**
 * Cernere 自身の /login・/composite/login が <CompositeLogin> に渡す日本語文言。
 * ログインはパスキーのみで、登録とログインを区別しない (SPEC-PASSKEY-CONTINUE)。
 */

import type { CompositeLoginLabels } from "@ludiars/cernere-composite/ui";

export const CERNERE_LOGIN_LABELS: Partial<CompositeLoginLabels> = {
  title: "Cernere",
  subtitle: "パスキーで続けます",
  processing: "処理中…",
  orContinueWith: "または",
  passkeyContinue: "🔐 パスキーで続ける",
  passkeyRetry: "🔐 もう一度試す",
  passkeyRunning: "認証器の応答を待っています…",
  passkeyUnsupported: "このブラウザはパスキー (WebAuthn) に対応していません。別のブラウザか端末を使ってください。",
  passkeyNotCompleted: "ログインは完了しませんでした。ダイアログを閉じたか、この端末に Cernere のパスキーがありません。",
  otherDeviceTitle: "パスキーが別の端末 (スマホなど) にありますか?",
  otherDeviceHint: "スマホなどでログインしてから、この端末にもパスキーを登録できます。下の「この端末にパスキーを登録する」へ進んでください。今回だけ入る場合は、もう一度試してブラウザの「スマートフォンまたは別のデバイスを使用」を選べます。",
  recoverWithQr: "すべての端末をなくした場合は、リカバリー QR で戻す",
  createAccount: "新しく始める",
  createAccountHint: "ログインが完了しない場合は、もう一度押すと、この端末への登録・別端末でのログイン・新規作成を選ぶ画面へ進みます。はじめての方は「はじめて使う」を選んでください。",
};
