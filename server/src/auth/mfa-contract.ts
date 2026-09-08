/** Shared MFA transport validation and result contracts. @implements SPEC-MFA-CHALLENGE */
import { z } from "zod";
import { AppError } from "../error.js";
import { mfaMethodSchema, type MfaMethod } from "./mfa-records.js";

const inputSchema = z.object({
  mfaToken: z.string().max(128).optional(), managementToken: z.string().max(128).optional(),
  method: mfaMethodSchema.optional(), code: z.string().max(32).optional(), password: z.string().max(1024).optional(),
}).strict();

export function parseMfaInput(body: unknown): z.infer<typeof inputSchema> {
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) throw AppError.badRequest("Invalid MFA request");
  return parsed.data;
}

export function requireMfaMethod(method: MfaMethod | undefined): MfaMethod {
  if (!method) throw AppError.badRequest("MFA method is required");
  return method;
}

export interface MfaChallengeResult { mfaRequired: true; mfaToken: string; mfaMethods: MfaMethod[] }
export interface MfaManagementResult { managementToken: string }
export interface MfaLoginResult {
  userId: string; accessToken: string; refreshToken: string;
  user: { id: string; displayName: string; email: string | null; role: string };
}
export interface MfaStatusResult {
  mfaEnabled: boolean; methods: MfaMethod[]; totpEnabled: boolean; emailEnabled: boolean;
  hasPassword: boolean; hasPasskey: boolean; hasEmail: boolean; totpAvailable: boolean; emailMfaAvailable: boolean;
  hasPhone: boolean; phoneVerified: boolean; smsAvailable: false;
}
