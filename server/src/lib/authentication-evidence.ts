/** Verified authentication facts; token refresh and consent never create new facts. @implements SPEC-ENTERPRISE-AUTH-FACTS */
import { z } from "zod";

export const authenticationEvidenceSchema = z.object({
  authTime: z.number().int().nonnegative(),
  authTimeMs: z.number().int().nonnegative(),
  amr: z.array(z.enum(["pwd", "otp", "mfa", "pop"])).min(1).max(4),
  revision: z.number().int().nonnegative(),
}).strict();
export type AuthenticationEvidence = z.infer<typeof authenticationEvidenceSchema>;

export function completedAuthentication(method: "password" | "totp" | "email" | "passkey", revision: number,
  now = Date.now()): AuthenticationEvidence {
  return { authTime: Math.floor(now / 1000), authTimeMs: now, revision,
    amr: method === "password" ? ["pwd"] : method === "passkey" ? ["pop", "mfa"] : ["pwd", "otp", "mfa"] };
}

export function readAuthenticationEvidence(value: unknown): AuthenticationEvidence | undefined {
  if (value == null) return undefined;
  return authenticationEvidenceSchema.parse(value);
}
