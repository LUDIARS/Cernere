/**
 * ログイン通知を宛先ごとに配送する (SPEC-LOGIN-ALERT)。
 *
 *   relay   本人の他の WS セッションへ即時表示 (常に有効)
 *   discord Cr 専用 Bot の DM
 *   google  Google 連携で検証済みのアドレスへメール (既存 mailer)
 */

import { sendMail } from "../auth/mailer.js";
import { sessionRegistry } from "../ws/session-registry.js";
import { renderAlertMessage, renderVerificationMessage, securityPageUrl } from "./alert-message.js";
import { escapeDiscord, sendDiscordDm } from "./discord-alert-sender.js";
import type { SecurityEventDetail, SecurityEventKind, SecuritySeverity } from "./security-events.js";

export interface DeliverableEvent {
  id: string;
  userId: string;
  kind: SecurityEventKind;
  severity: SecuritySeverity;
  detail: SecurityEventDetail;
  createdAt: Date;
}

export async function deliverAlert(channel: string, targetRef: string, event: DeliverableEvent): Promise<void> {
  if (channel === "relay") {
    // 接続中のセッションが無ければ何もしない (その場合も外部の宛先へは別行で届く)。
    sessionRegistry.sendToUser(targetRef, {
      type: "event",
      event: "security_alert",
      payload: {
        id: event.id,
        kind: event.kind,
        severity: event.severity,
        detail: event.detail,
        createdAt: event.createdAt.toISOString(),
        securityUrl: securityPageUrl(),
      },
    });
    return;
  }
  if (channel === "discord") return sendDiscordDm(targetRef, renderAlertMessage(event, escapeDiscord).body);
  const message = renderAlertMessage(event);
  if (channel === "google") {
    await sendMail({ to: targetRef, subject: message.subject, text: message.body });
    return;
  }
  throw new Error(`Unknown alert channel: ${channel}`);
}

/** 宛先を有効化する前の試験通知。届いた確認番号を Cr の画面で入れてもらう。 */
export async function deliverVerificationCode(channel: "discord" | "google", address: string, code: string): Promise<void> {
  const message = renderVerificationMessage(code);
  if (channel === "discord") return sendDiscordDm(address, message.body);
  await sendMail({ to: address, subject: message.subject, text: message.body });
}
