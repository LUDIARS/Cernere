export interface CompositePkce { codeVerifier: string; codeChallenge: string; state: string }
export interface CompositeAuthorizationRequest { clientId: string; codeChallenge: string; state: string }

/** @implements SPEC-COMPOSITE-PROJECT-PKCE */
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** RFC 7636 S256, using the platform's CSPRNG and SHA-256 implementation. @implements SPEC-COMPOSITE-PROJECT-PKCE */
export async function createCompositePkce(): Promise<CompositePkce> {
  const codeVerifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return { codeVerifier, codeChallenge: base64url(new Uint8Array(digest)), state: base64url(crypto.getRandomValues(new Uint8Array(32))) };
}

/** @implements SPEC-COMPOSITE-PROJECT-PKCE */
export function compositeLoginUrl(cernereUrl: string, request: CompositeAuthorizationRequest): URL {
  if (!request.clientId || !/^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge) || !/^[A-Za-z0-9_-]{32,512}$/.test(request.state)) throw new Error("Composite project, PKCE challenge and state are required");
  const url = new URL("/composite/login", cernereUrl);
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("state", request.state);
  return url;
}
