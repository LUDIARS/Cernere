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
  otherDeviceHint: "もう一度試し、ブラウザの画面で「スマートフォンまたは別のデバイスを使用」を選んで、表示される QR をその端末で読み取ってください。",
  recoverWithQr: "すべての端末をなくした場合は、リカバリー QR で戻す",
  createAccount: "新しく始める",
  createAccountHint: "Cernere を一度も使ったことがない場合だけ押してください。この端末に新しいパスキーを作ります。",
};
