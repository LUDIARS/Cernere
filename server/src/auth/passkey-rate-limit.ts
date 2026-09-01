/** Trust-aware rate-limit identities for unauthenticated passkey ceremonies. */

export interface PasskeyRateLimitContext {
  /** Server-observed peer IP. Only authoritative on direct REST requests. */
  ip?: string;
  /** Authenticated project identity bound to the project WebSocket. */
  projectKey?: string;
}

/**
 * Project WS traffic is always scoped by its authenticated project, never payload metadata.
 * @implements SPEC-COMPOSITE-PASSKEY-RATE-LIMIT
 */
export function passkeyAnonymousRateLimitScope(ctx: PasskeyRateLimitContext): string {
  return ctx.projectKey ? `project:${ctx.projectKey}` : (ctx.ip ?? "anon");
}

/**
 * REST may use a selected account email; project WS callers cannot choose their limit identity.
 * @implements SPEC-COMPOSITE-PASSKEY-RATE-LIMIT
 */
export function passkeyLoginRateLimitScope(
  email: string,
  ctx: PasskeyRateLimitContext,
): string {
  return ctx.projectKey
    ? passkeyAnonymousRateLimitScope(ctx)
    : (email || passkeyAnonymousRateLimitScope(ctx));
}
