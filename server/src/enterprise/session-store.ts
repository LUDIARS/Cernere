/** Opaque enterprise sessions with an immutable absolute deadline. @implements SPEC-ENTERPRISE-SESSION */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { redis } from "../redis.js";
import { AppError } from "../error.js";

export const enterpriseSessionSchema = z.object({
  userId: z.string().uuid(), projectKey: z.string().min(1), organizationId: z.string().uuid(),
  connectionRevision: z.string().uuid(), identityRevision: z.string().uuid(), subjectHash: z.string().regex(/^[a-f0-9]{64}$/),
  organizationRole: z.string().min(1), memberJoinedAt: z.string(), authenticationRevision: z.number().int(),
  authTime: z.number().int(), amr: z.array(z.string()), expiresAt: z.number().int(),
}).strict();
export type EnterpriseSession = z.infer<typeof enterpriseSessionSchema>;

export function enterpriseSessionKey(token: string): string {
  if (!/^ces_[A-Za-z0-9_-]{43}$/.test(token)) throw AppError.unauthorized("Invalid enterprise session");
  return "enterprise-session:" + createHash("sha256").update(token).digest("hex");
}
export async function issueEnterpriseSession(record: EnterpriseSession, now = Date.now()): Promise<string> {
  // Compare whole seconds on both sides. Subtracting fractional milliseconds would floor
  // the TTL a second below expiresAt, and each rotation would compound that loss.
  const ttl = record.expiresAt - Math.floor(now / 1000);
  if (ttl <= 0) throw AppError.unauthorized("Enterprise session expired");
  const token = "ces_" + randomBytes(32).toString("base64url");
  await redis.set(enterpriseSessionKey(token), JSON.stringify(enterpriseSessionSchema.parse(record)), "EX", ttl);
  return token;
}
export async function readEnterpriseSession(token: string, now = Date.now()): Promise<EnterpriseSession> {
  const raw = await redis.get(enterpriseSessionKey(token));
  if (!raw) throw AppError.unauthorized("Enterprise session expired or revoked");
  const record = enterpriseSessionSchema.safeParse(JSON.parse(raw));
  if (!record.success || record.data.expiresAt * 1000 <= now) throw AppError.unauthorized("Enterprise session expired or invalid");
  return record.data;
}
export async function deleteEnterpriseSession(token: string): Promise<void> { await redis.del(enterpriseSessionKey(token)); }
