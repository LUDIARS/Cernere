/** Trust-aware rate-limit identities for unauthenticated passkey ceremonies. */

export interface PasskeyRateLimitContext {
  /** Client IP (http/client-ip.ts: CF-Connecting-IP behind a trusted proxy, otherwise the peer). */
  ip?: string;
  /** Authenticated project identity bound to the project WebSocket. */
  projectKey?: string;
}

export interface RateLimitRule {
  key: string;
  max: number;
  windowSecs: number;
}

const LOGIN_WINDOW_SECS = 15 * 60;
/** 同じ接続元から同じアカウントへの開始回数。 */
const LOGIN_PER_ACCOUNT_AND_IP = 30;
/** 1 つの接続元からの開始回数。 学校など NAT 配下の多人数を潰さない余裕を持たせる。 */
const LOGIN_PER_IP = 300;

/**
 * Project WS traffic is always scoped by its authenticated project, never payload metadata.
 * @implements SPEC-COMPOSITE-PASSKEY-RATE-LIMIT
 */
export function passkeyAnonymousRateLimitScope(ctx: PasskeyRateLimitContext): string {
  return ctx.projectKey ? `project:${ctx.projectKey}` : (ctx.ip ?? "anon");
}

/**
 * Login-begin limits. Project WS callers cannot choose their limit identity. REST never limits by
 * the email alone: anyone could then lock a chosen account out by sending its address repeatedly.
 * @implements SPEC-COMPOSITE-PASSKEY-RATE-LIMIT
 */
export function passkeyLoginRateLimits(email: string, ctx: PasskeyRateLimitContext): RateLimitRule[] {
  if (ctx.projectKey) {
    return [{ key: `passkey-login:${passkeyAnonymousRateLimitScope(ctx)}`, max: LOGIN_PER_ACCOUNT_AND_IP, windowSecs: LOGIN_WINDOW_SECS }];
  }
  const ip = ctx.ip ?? "anon";
  const rules: RateLimitRule[] = [{ key: `passkey-login:ip:${ip}`, max: LOGIN_PER_IP, windowSecs: LOGIN_WINDOW_SECS }];
  if (email) {
    rules.push({ key: `passkey-login:account:${email.toLowerCase()}:ip:${ip}`, max: LOGIN_PER_ACCOUNT_AND_IP, windowSecs: LOGIN_WINDOW_SECS });
  }
  return rules;
}
