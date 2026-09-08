/** Email OTP delivery without plaintext persistence or delivery fallbacks. @implements SPEC-MFA-EMAIL */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { AppError } from "../error.js";
import { redis } from "../redis.js";
import { sendMail } from "./mailer.js";
import { limitMfa, remainingMfaSeconds, type MfaTicket } from "./mfa-records.js";

export function isMfaMailConfigured(): boolean {
  return config.awsSesEnabled
    ? Boolean(process.env.AWS_SES_FROM_EMAIL)
    : Boolean(process.env.CERNERE_SMTP_HOST && process.env.CERNERE_MAIL_FROM);
}

function codeHash(ticket: MfaTicket, code: string): string {
  return createHmac("sha256", config.jwtSecret).update(`mfa-email:${ticket.digest}:${code}`).digest("hex");
}

export async function sendMfaMail(ticket: MfaTicket, email: string | null): Promise<void> {
  if (!email || !isMfaMailConfigured()) throw AppError.serviceUnavailable("MFA email delivery is not configured");
  await limitMfa(`send-spacing:${ticket.record.userId}`, 1, 60);
  await limitMfa(`send-ticket:${ticket.digest}`, 3, 300);
  await limitMfa(`send-user:${ticket.record.userId}`, 5);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const raw = codeHash(ticket, code);
  const key = `mfa-mail:${ticket.digest}`;
  await redis.set(key, raw, "EX", remainingMfaSeconds(ticket));
  try {
    await sendMail({ to: email, subject: "【Cernere】本人確認コード", text:
      `Cernere の本人確認コードは ${code} です。\n有効期限は認証開始から5分、入力は5回までです。\n心当たりがない場合は入力・共有しないでください。` });
  } catch {
    // Remove only this delivery's code; a concurrent operation must not be deleted.
    await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", 1, key, raw);
    throw AppError.serviceUnavailable("MFA email could not be sent. Please retry later.");
  }
}

export async function verifyMfaMail(ticket: MfaTicket, code: string): Promise<string> {
  const expected = await redis.get(`mfa-mail:${ticket.digest}`);
  const actual = codeHash(ticket, code);
  if (!/^\d{6}$/.test(code) || !expected || expected.length !== actual.length
    || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
    throw AppError.unauthorized("Invalid or expired MFA code");
  }
  return expected;
}
