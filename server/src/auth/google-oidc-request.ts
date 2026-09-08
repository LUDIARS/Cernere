/** One-use Google OIDC requests bind state, nonce, PKCE and an optional Cr OIDC continuation. */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { redis } from "../redis.js";
import { AppError } from "../error.js";

export const GOOGLE_OIDC_REQUEST_TTL = 600;
const requestSchema = z.object({
  clientId: z.string().min(1), redirectUri: z.string().url(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  oidcRequestId: z.string().uuid().optional(),
  browserState: z.string().uuid().optional(),
}).strict();
export type GoogleOidcRequest = z.infer<typeof requestSchema>;

function keyFor(state: string): string {
  if (!state || state.length > 4096) throw AppError.badRequest("Invalid Google sign-in state");
  return `googleoidc:${createHash("sha256").update(state).digest("hex")}`;
}

/** @implements SPEC-GOOGLE-OIDC-REQUEST */
export async function createGoogleOidcRequest(
  state: string, context: Pick<GoogleOidcRequest, "clientId" | "redirectUri" | "oidcRequestId" | "browserState">,
): Promise<GoogleOidcRequest> {
  const parsed = requestSchema.safeParse({ ...context,
    nonce: randomBytes(32).toString("base64url"), codeVerifier: randomBytes(32).toString("base64url") });
  if (!parsed.success) throw AppError.badRequest("Invalid Google sign-in request");
  await redis.set(keyFor(state), JSON.stringify(parsed.data), "EX", GOOGLE_OIDC_REQUEST_TTL);
  return parsed.data;
}

/** Cookie equality must be checked before consumption. @implements SPEC-GOOGLE-OIDC-REQUEST */
export async function consumeGoogleOidcRequest(state: string): Promise<GoogleOidcRequest> {
  const raw = await redis.getdel(keyFor(state));
  let value: unknown;
  try { value = raw ? JSON.parse(raw) : null; }
  catch { throw AppError.unauthorized("Invalid Google sign-in request; start again"); }
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw AppError.unauthorized("Google sign-in expired or already used; start again");
  return parsed.data;
}
