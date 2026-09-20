/** Cloudflare's signed application assertion, without email-based identity linking. @implements SPEC-ENTERPRISE-ASSERTION */
import jwt from "jsonwebtoken";
import { z } from "zod";
import { getEdgeSigningKey, type FetchLike } from "../auth/edge-jwks.js";
import { AppError } from "../error.js";
import type { EnterpriseConnection } from "./connections.js";

const assertionSchema = z.object({
  sub: z.string().uuid(), type: z.literal("app"),
  iat: z.number().int().nonnegative(), exp: z.number().int().positive(),
  common_name: z.string().max(0).optional(),
});
export interface CloudflareAuthentication { subject: string; userId: string; authTime: number; amr: string[]; expiresAt: number; issuedAt: number; authenticationRevision: number }

export async function verifyCloudflareAuthentication(connection: EnterpriseConnection, assertion: string,
  options: { now?: number; fetchImpl?: FetchLike } = {}): Promise<CloudflareAuthentication> {
  const now = options.now ?? Date.now();
  const seconds = Math.floor(now / 1000);
  if (typeof assertion !== "string" || assertion.length > 16384) throw AppError.unauthorized("Invalid Cloudflare assertion");
  try {
    const decoded = jwt.decode(assertion, { complete: true });
    if (!decoded || decoded.header.alg !== "RS256" || typeof decoded.header.kid !== "string" || decoded.header.kid.length > 256) throw new Error("header");
    const boundedFetch: FetchLike = (input, init) => (options.fetchImpl ?? fetch)(input,
      { ...init, signal: AbortSignal.timeout(10000) });
    const key = await getEdgeSigningKey(connection.teamDomain, decoded.header.kid, now, boundedFetch, false);
    if (!key) throw new Error("key");
    const payload = jwt.verify(assertion, key, { algorithms: ["RS256"], issuer: "https://" + connection.teamDomain,
      audience: connection.audience, clockTimestamp: seconds, clockTolerance: 0 });
    if (typeof payload === "string") throw new Error("payload");
    const claims = assertionSchema.parse(payload);
    if (claims.exp <= seconds || claims.exp <= claims.iat || claims.iat > seconds + 60) throw new Error("time");
    const custom = payload.custom && typeof payload.custom === "object" && !Array.isArray(payload.custom)
      ? payload.custom as Record<string, unknown> : {};
    // Access can relay OIDC amr/auth_time in signed custom claims. Missing/truncated facts cannot prove freshness.
    const amr = z.array(z.string().min(1).max(64)).min(1).max(16).parse(custom.amr);
    const authTime = z.number().int().nonnegative().parse(custom.auth_time);
    const authenticationRevision = z.number().int().nonnegative().parse(custom.cr_auth_revision);
    const userId = z.string().uuid().parse(custom.cr_user_id);
    if (custom.cr_connection_revision !== connection.revision) throw new Error("connection revision");
    if (authTime > claims.iat + 60 || authTime > seconds + 60 || seconds - authTime > connection.maxAuthenticationAge) throw new Error("authentication age");
    if (connection.requireMfa && !amr.includes("mfa")) throw new Error("MFA evidence");
    return { subject: claims.sub, userId, authTime, amr, expiresAt: claims.exp, issuedAt: claims.iat, authenticationRevision };
  } catch {
    throw AppError.unauthorized("Cloudflare assertion, authentication method, or authentication time could not be verified");
  }
}
