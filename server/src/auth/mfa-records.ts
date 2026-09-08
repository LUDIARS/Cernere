/** Expiring, purpose-bound MFA tickets; Qs OTP's bounded, single-use contract. @implements SPEC-MFA-CHALLENGE */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { redis } from "../redis.js";
import { AppError } from "../error.js";

export const MFA_TTL_SECONDS = 300;
export const mfaMethodSchema = z.enum(["totp", "email"]);
export type MfaMethod = z.infer<typeof mfaMethodSchema>;
const recordSchema = z.object({
  userId: z.string().uuid(),
  purpose: z.enum(["rest", "guest", "composite", "manage", "settings"]),
  snapshot: z.string(),
  binding: z.string().nullable(),
  projectKey: z.string().nullable(),
  expiresAt: z.number().int(),
}).strict();
export type MfaRecord = z.infer<typeof recordSchema>;
export type MfaPurpose = MfaRecord["purpose"];
export interface MfaTicket { key: string; digest: string; raw: string; record: MfaRecord }
export interface MfaContext { purpose: MfaPurpose; binding?: string; projectKey?: string }

export async function issueMfaTicket(record: Omit<MfaRecord, "expiresAt">): Promise<string> {
  const token = `mfa_${randomBytes(32).toString("base64url")}`;
  await redis.set(ticketKey(token), JSON.stringify({ ...record, expiresAt: Date.now() + MFA_TTL_SECONDS * 1000 }), "EX", MFA_TTL_SECONDS);
  return token;
}

function ticketKey(token: string): string {
  if (!/^mfa_[A-Za-z0-9_-]{43}$/.test(token)) throw AppError.unauthorized("MFA challenge is invalid or expired");
  return `mfa-ticket:${createHash("sha256").update(token).digest("hex")}`;
}

export async function readMfaTicket(token: string, context: MfaContext): Promise<MfaTicket> {
  const key = ticketKey(token);
  const raw = await redis.get(key);
  if (!raw) throw AppError.unauthorized("MFA challenge is invalid or expired");
  let record: MfaRecord;
  try { record = recordSchema.parse(JSON.parse(raw)); }
  catch { throw AppError.unauthorized("MFA challenge is invalid"); }
  if (record.expiresAt <= Date.now() || record.purpose !== context.purpose
    || record.binding !== (context.binding ?? null) || record.projectKey !== (context.projectKey ?? null)) {
    throw AppError.unauthorized("MFA challenge does not match this operation");
  }
  return { key, digest: key.slice("mfa-ticket:".length), raw, record };
}

const CONSUME = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] ~= '' and redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
return 1
`;
export async function consumeMfaTicket(ticket: MfaTicket, mailRaw?: string): Promise<void> {
  // A DB row lock may have delayed the caller after its initial ticket read.
  remainingMfaSeconds(ticket);
  const consumed = await redis.eval(CONSUME, 3, ticket.key, `mfa-mail:${ticket.digest}`, `mfa-setup:${ticket.digest}`, ticket.raw, mailRaw ?? "");
  if (Number(consumed) !== 1) throw AppError.unauthorized("MFA challenge expired, changed, or was already used");
}

const LIMIT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`;
export async function limitMfa(key: string, maximum: number, seconds = 900): Promise<void> {
  const count = Number(await redis.eval(LIMIT, 1, `mfa-limit:${key}`, String(seconds)));
  if (!Number.isInteger(count) || count < 1) throw AppError.serviceUnavailable("MFA rate limiter is unavailable");
  if (count > maximum) throw new AppError(429, "MFA attempt limit reached. Please wait before retrying.");
}

export async function countMfaAttempt(ticket: MfaTicket): Promise<void> {
  await limitMfa(`verify-user:${ticket.record.userId}`, 20);
  await limitMfa(`verify-ticket:${ticket.digest}`, 5, MFA_TTL_SECONDS);
}

export function remainingMfaSeconds(ticket: MfaTicket): number {
  const seconds = Math.floor((ticket.record.expiresAt - Date.now()) / 1000);
  if (seconds < 1) throw AppError.unauthorized("MFA challenge expired");
  return seconds;
}
