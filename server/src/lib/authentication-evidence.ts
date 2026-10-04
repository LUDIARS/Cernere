/** Verified authentication facts; token refresh and consent never create new facts. @implements SPEC-ENTERPRISE-AUTH-FACTS */
import { z } from "zod";

export const authenticationEvidenceSchema = z.object({
  authTime: z.number().int().nonnegative(),
  authTimeMs: z.number().int().nonnegative(),
  amr: z.array(z.enum(["pwd", "otp", "mfa", "pop"])).min(1).max(4),
  revision: z.number().int().nonnegative(),
}).strict();
export type AuthenticationEvidence = z.infer<typeof authenticationEvidenceSchema>;

export function completedAuthentication(method: "password" | "totp" | "email" | "passkey" | "onsite", revision: number,
  now = Date.now()): AuthenticationEvidence {
  return { authTime: Math.floor(now / 1000), authTimeMs: now, revision, amr: amrOf(method) };
}

function amrOf(method: "password" | "totp" | "email" | "passkey" | "onsite"): AuthenticationEvidence["amr"] {
  if (method === "password") return ["pwd"];
  if (method === "passkey") return ["pop", "mfa"];
  // Onsite: password plus a kiosk-verified presence factor; no OTP was entered.
  if (method === "onsite") return ["pwd", "mfa"];
  return ["pwd", "otp", "mfa"];
}

export function readAuthenticationEvidence(value: unknown): AuthenticationEvidence | undefined {
  if (value == null) return undefined;
  return authenticationEvidenceSchema.parse(value);
}
