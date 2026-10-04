/** Expiring, purpose-bound MFA tickets; Qs OTP's bounded, single-use contract. @implements SPEC-MFA-CHALLENGE */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { redis } from "../redis.js";
import { AppError } from "../error.js";

export const MFA_TTL_SECONDS = 300;
export const mfaMethodSchema = z.enum(["totp", "email", "onsite"]);
export type MfaMethod = z.infer<typeof mfaMethodSchema>;
/** A ticket's onsite requirement (SPEC-MFA-ONSITE); present only when the project requires it. */
const onsiteRequirementSchema = z.object({
  minAssurance: z.enum(["high", "medium"]),
  allowedPlaceIds: z.array(z.string()).nullable(),
}).strict();
const recordSchema = z.object({
  userId: z.string().uuid(),
  purpose: z.enum(["rest", "guest", "composite", "manage", "settings"]),
  snapshot: z.string(),
  binding: z.string().nullable(),
  projectKey: z.string().nullable(),
  // Optional so tickets issued before onsite support keep parsing during a rollout.
  mfaRevision: z.number().int().nonnegative().optional(),
  onsite: onsiteRequirementSchema.nullable().optional(),
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
  const ticket = await loadMfaTicket(ticketKey(token));
  if (!ticket) throw AppError.unauthorized("MFA challenge is invalid or expired");
  const { record } = ticket;
  if (record.purpose !== context.purpose
    || record.binding !== (context.binding ?? null) || record.projectKey !== (context.projectKey ?? null)) {
    throw AppError.unauthorized("MFA challenge does not match this operation");
  }
  return ticket;
}

/**
 * Purpose-agnostic read for onsite start, which the user's device calls directly with the ticket
 * it already holds. Only tickets carrying an onsite requirement are accepted there.
 */
export async function readOnsiteMfaTicket(token: string): Promise<MfaTicket & { record: MfaRecord & { onsite: OnsiteTicketRequirement } }> {
  const ticket = await loadMfaTicket(ticketKey(token));
  if (!ticket) throw AppError.unauthorized("MFA challenge is invalid or expired");
  if (!ticket.record.onsite) throw AppError.badRequest("This MFA challenge does not use onsite verification");
  return ticket as MfaTicket & { record: MfaRecord & { onsite: OnsiteTicketRequirement } };
}

/** Kiosk-submitted attestations reach the ticket only through its nonce binding (digest). */
export async function readMfaTicketByDigest(digest: string): Promise<MfaTicket | null> {
  if (!/^[0-9a-f]{64}$/.test(digest)) return null;
  return loadMfaTicket(`mfa-ticket:${digest}`);
}

async function loadMfaTicket(key: string): Promise<MfaTicket | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  let record: MfaRecord;
  try { record = recordSchema.parse(JSON.parse(raw)); }
  catch { throw AppError.unauthorized("MFA challenge is invalid"); }
  if (record.expiresAt <= Date.now()) return null;
  return { key, digest: key.slice("mfa-ticket:".length), raw, record };
}

export type OnsiteTicketRequirement = z.infer<typeof onsiteRequirementSchema>;

export const CONSUME_MFA_TICKET = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] ~= '' and redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
if ARGV[3] ~= '' and redis.call('GET', KEYS[4]) ~= ARGV[3] then return 0 end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
return 1
`;
/** Redis key holding the kiosk-verified onsite satisfaction of a ticket (SPEC-MFA-ONSITE). */
export function onsiteSatisfactionKey(digest: string): string { return `mfa-onsite:${digest}`; }

/**
 * One atomic consume for all concurrent requests. mailRaw / onsiteRaw pin the factor evidence
 * that was checked, so a replaced or already-consumed proof fails the consume.
 */
export async function consumeMfaTicket(ticket: MfaTicket, mailRaw?: string, onsiteRaw?: string): Promise<void> {
  // A DB row lock may have delayed the caller after its initial ticket read.
  remainingMfaSeconds(ticket);
  const consumed = await redis.eval(CONSUME_MFA_TICKET, 4, ticket.key, `mfa-mail:${ticket.digest}`, `mfa-setup:${ticket.digest}`,
    onsiteSatisfactionKey(ticket.digest), ticket.raw, mailRaw ?? "", onsiteRaw ?? "");
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
