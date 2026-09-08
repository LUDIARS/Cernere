/** Google authorization-code flow using the existing Google OAuth client registration. */
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { AppError } from "../error.js";
import { createGoogleOidcRequest, consumeGoogleOidcRequest } from "./google-oidc-request.js";
import { verifyGoogleIdToken, type GoogleIdentity } from "./google-id-token.js";

function requireGoogleConfig(): string[] {
  if (!config.googleClientId.trim() || !config.googleClientSecret.trim()) {
    throw AppError.serviceUnavailable("Google OIDC is not configured");
  }
  let redirect: URL;
  try { redirect = new URL(config.googleRedirectUri); }
  catch { throw AppError.serviceUnavailable("Invalid Google redirect URI configuration"); }
  if (redirect.username || redirect.password || redirect.hash
    || (redirect.protocol !== "https:" && !(redirect.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)))) {
    throw AppError.serviceUnavailable("Google redirect URI must use HTTPS outside localhost");
  }
  const domains = config.googleOidcHostedDomains.split(",").map((domain) => domain.trim().toLowerCase()).filter(Boolean);
  if ((config.googleOidcHostedDomains.trim() !== "" && domains.length === 0)
    || domains.some((domain) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))) {
    throw AppError.serviceUnavailable("Invalid Google hosted domain configuration");
  }
  return domains;
}

/** @implements SPEC-GOOGLE-OIDC-REQUEST */
export async function startGoogleOidc(state: string, oidcRequestId?: string, browserState?: string): Promise<string> {
  const domains = requireGoogleConfig();
  const request = await createGoogleOidcRequest(state, { clientId: config.googleClientId,
    redirectUri: config.googleRedirectUri, oidcRequestId, browserState });
  const params = new URLSearchParams({ client_id: request.clientId, redirect_uri: request.redirectUri,
    response_type: "code", scope: "openid email profile", state, nonce: request.nonce,
    code_challenge: createHash("sha256").update(request.codeVerifier).digest("base64url"), code_challenge_method: "S256" });
  if (domains.length === 1) params.set("hd", domains[0]);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** @implements SPEC-GOOGLE-OIDC-VERIFICATION */
export async function completeGoogleOidc(state: string, code: string): Promise<{
  identity: GoogleIdentity; oidcRequestId?: string; browserState?: string;
}> {
  const hostedDomains = requireGoogleConfig();
  if (!code || code.length > 4096) throw AppError.badRequest("Invalid Google authorization code");
  const request = await consumeGoogleOidcRequest(state);
  if (request.clientId !== config.googleClientId || request.redirectUri !== config.googleRedirectUri) {
    throw AppError.unauthorized("Google sign-in configuration changed; start again");
  }
  let token: unknown;
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", redirect: "error",
      signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: request.clientId, client_secret: config.googleClientSecret,
        redirect_uri: request.redirectUri, grant_type: "authorization_code", code, code_verifier: request.codeVerifier }) });
    if (!response.ok) throw new Error("Code exchange failed");
    token = await response.json();
  } catch { throw AppError.unauthorized("Google authorization code could not be exchanged; start again"); }
  if (!token || typeof token !== "object" || !("id_token" in token) || typeof token.id_token !== "string") {
    throw AppError.unauthorized("Google did not return an ID token");
  }
  const identity = await verifyGoogleIdToken(token.id_token, { clientId: request.clientId, nonce: request.nonce, hostedDomains });
  // Authentication only: do not persist Google API access/refresh tokens or relay them to other apps.
  return { identity, oidcRequestId: request.oidcRequestId, browserState: request.browserState };
}
