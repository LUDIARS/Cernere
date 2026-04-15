/**
 * Mail 送信モジュール
 *
 * 優先順位:
 *   1. AWS_SES_ENABLED=true → SES (本番)
 *   2. それ以外            → SMTP (dev: MailHog / prod: 任意のSMTPサーバ)
 *
 * 送信失敗時は Error を throw する。呼び出し側で try/catch すること。
 */

import nodemailer, { type Transporter } from "nodemailer";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { config } from "../config.js";

export interface SendMailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type MailChannel = "ses" | "smtp";

export interface SendMailResult {
  channel: MailChannel;
  messageId?: string;
}

// ── SMTP トランスポート (遅延初期化) ─────────────────────────

let smtpTransporter: Transporter | null = null;

function getSmtpTransporter(): Transporter {
  if (smtpTransporter) return smtpTransporter;
  const auth = config.smtpUser && config.smtpPass
    ? { user: config.smtpUser, pass: config.smtpPass }
    : undefined;
  smtpTransporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    // 25/465/587 以外 (典型的な MailHog=1025) は secure=false + STARTTLS 省略
    secure: config.smtpPort === 465,
    auth,
  });
  return smtpTransporter;
}

async function sendViaSmtp(input: SendMailInput): Promise<SendMailResult> {
  const transporter = getSmtpTransporter();
  const info = await transporter.sendMail({
    from: config.mailFrom,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
  return { channel: "smtp", messageId: info.messageId };
}

// ── SES トランスポート (遅延初期化) ──────────────────────────

let sesClient: SESClient | null = null;

function getSesClient(): SESClient {
  if (sesClient) return sesClient;
  sesClient = new SESClient({ region: config.awsRegion });
  return sesClient;
}

async function sendViaSes(input: SendMailInput): Promise<SendMailResult> {
  const client = getSesClient();
  const from = config.awsSesFromEmail || config.mailFrom;
  const cmd = new SendEmailCommand({
    Source: from,
    Destination: { ToAddresses: [input.to] },
    Message: {
      Subject: { Data: input.subject, Charset: "UTF-8" },
      Body: {
        Text: { Data: input.text, Charset: "UTF-8" },
        ...(input.html ? { Html: { Data: input.html, Charset: "UTF-8" } } : {}),
      },
    },
  });
  const res = await client.send(cmd);
  return { channel: "ses", messageId: res.MessageId };
}

// ── 公開 API ────────────────────────────────────────────────

export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  if (!input.to) throw new Error("sendMail: recipient 'to' is required");
  if (config.awsSesEnabled) {
    return sendViaSes(input);
  }
  return sendViaSmtp(input);
}
