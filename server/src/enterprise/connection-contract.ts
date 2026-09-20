/** Administrator-owned Cloudflare connection contract. @implements SPEC-ENTERPRISE-CONNECTION */
import { z } from "zod";
import { AppError } from "../error.js";

export const connectionInput = z.object({
  projectKey: z.string().min(1).max(128), organizationId: z.string().uuid(), oidcClientId: z.string().min(1).max(128),
  teamDomain: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/),
  audience: z.string().regex(/^[a-f0-9]{64}$/),
  requireMfa: z.boolean(), maxAuthenticationAge: z.number().int().min(60).max(86400),
  maxSessionSeconds: z.number().int().min(60).max(86400), isActive: z.boolean(),
  expectedRevision: z.string().uuid().nullable(),
}).strict();
export type ConnectionInput = z.infer<typeof connectionInput>;
export function parseConnection(value: unknown): ConnectionInput {
  const result = connectionInput.safeParse(value);
  if (!result.success) throw AppError.badRequest("Invalid enterprise connection settings");
  return result.data;
}

export const identityInput = z.object({ projectKey: z.string().min(1).max(128), userId: z.string().uuid(),
  cloudflareSubject: z.string().uuid(), isActive: z.boolean() }).strict();
