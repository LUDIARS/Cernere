/**
 * ログイン通知の文面 (SPEC-LOGIN-ALERT)。
 *
 * 載せるのは出来事・時刻・端末の概略・固定 URL だけ。秘密値・token・完全な IP・userId・
 * メールアドレスは載せず、ログインに使えるリンクも載せない (通知フィッシングと区別できるよう、
 * 本文に「Cernere はログインリンクを送らない」を常に書く)。端末の概略は送信者が偽れる
 * 文字列なので、宛先ごとのエスケープは送信側で行う。
 */

import { config } from "../config.js";
import type { SecurityEventDetail, SecurityEventKind } from "./security-events.js";

const HEADLINES: Record<SecurityEventKind, string> = {
  "session.new": "新しいログインがありました",
  "passkey.pairing_requested": "別の端末からパスキー追加の要求がありました",
  "passkey.added": "パスキーが追加されました",
  "passkey.removed": "パスキーが削除されました",
  "recovery.requested": "リカバリー QR が使われました",
  "recovery.cancelled": "保留中の回復を取り消しました",
  "recovery.completed": "リカバリー QR による回復が完了しました",
  "recovery.code_reissued": "リカバリー QR を作り直しました",
  "recovery.operator": "運用者による回復が行われました",
  "session.revoke_all": "すべての端末からログアウトしました",
  "alert_target.added": "ログイン通知の宛先が追加されました",
  "alert_target.removed": "ログイン通知の宛先が外されました",
};

const GUIDANCE: Partial<Record<SecurityEventKind, string>> = {
  "recovery.requested": "心当たりがなければ、今お使いの端末でログインし、保留中の回復を取り消してください。期限までに取り消さないと、他の端末のパスキーはすべて使えなくなります。",
  "passkey.pairing_requested": "心当たりがなければ、元の端末で承認せずに拒否してください。",
  "passkey.added": "心当たりがなければ、すぐにログインして追加されたパスキーを削除してください。",
  "session.new": "心当たりがなければ、ログインして該当する端末を失効させてください。",
};

export interface AlertMessage {
  subject: string;
  body: string;
}

function formatTime(at: Date): string {
  const jst = new Date(at.getTime() + 9 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 16);
  return `${jst} JST (${at.toISOString()})`;
}

export function securityPageUrl(): string {
  return new URL("/security", config.frontendUrl).toString();
}

/** 宛先ごとに可変部分 (端末の概略など) を無害化する。固定文と URL は加工しない。 */
export type FieldEscaper = (value: string) => string;

export function renderAlertMessage(event: {
  id: string;
  kind: SecurityEventKind;
  detail: SecurityEventDetail;
  createdAt: Date;
}, escape: FieldEscaper = (value) => value): AlertMessage {
  const headline = HEADLINES[event.kind];
  const lines = [
    `Cernere: ${headline}`,
    "",
    `日時: ${formatTime(event.createdAt)}`,
  ];
  if (event.detail.device) lines.push(`端末: ${escape(event.detail.device)}`);
  if (event.detail.country) lines.push(`地域: ${escape(event.detail.country)}`);
  if (event.detail.channel) lines.push(`宛先: ${event.detail.channel === "discord" ? "Discord" : "Google"}`);
  if (event.detail.eligibleAt) lines.push(`回復が確定する時刻: ${formatTime(new Date(event.detail.eligibleAt))}`);
  const guidance = GUIDANCE[event.kind];
  if (guidance) lines.push("", guidance);
  lines.push(
    "",
    `確認: ${securityPageUrl()} (パスキーでのログインが必要です)`,
    `イベント番号: ${event.id.slice(0, 8)}`,
    "",
    "Cernere はログインリンクを送らず、DM やメールでパスキーや QR を尋ねることはありません。",
  );
  return { subject: `[Cernere] ${headline}`, body: lines.join("\n") };
}

export function renderVerificationMessage(code: string): AlertMessage {
  return {
    subject: "[Cernere] ログイン通知の確認番号",
    body: [
      "Cernere のログイン通知をこの宛先に設定しようとしています。",
      "",
      `確認番号: ${code}`,
      "",
      "Cernere の設定画面にこの番号を入力すると、通知が届くようになります (10 分で無効になります)。",
      "心当たりがなければ、このメッセージは無視してください。",
    ].join("\n"),
  };
}
