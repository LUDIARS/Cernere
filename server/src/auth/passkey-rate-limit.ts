/** Trust-aware rate-limit identities for unauthenticated passkey ceremonies. */

import { rateLimitSubject } from "../http/rate-limit-subject.js";

export interface PasskeyRateLimitContext {
  /** Client IP (http/client-ip.ts: CF-Connecting-IP behind a trusted proxy, otherwise the peer). */
  ip?: string;
  /** Authenticated project identity bound to the project WebSocket. */
  projectKey?: string;
  /**
   * Project WS only: the service's own hint of which end user is asking (its observed client IP).
   * The service can choose it freely, so it only splits that project's own budget and never widens it.
   */
  clientHint?: string;
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
 * 埋め込み SDK 経由 (project WS) のサービス全体の開始回数。1 枠を小さくすると、そのサービスの
 * ログイン画面を 31 回押すだけで全利用者が締め出される。全体は大きく取り、利用者ごとはヒントで分ける。
 */
const LOGIN_PER_PROJECT = 3000;

/**
 * Project WS traffic is always scoped by its authenticated project, never payload metadata.
 * Direct REST traffic is scoped by the client's /64 (IPv6) or address (IPv4).
 * @implements SPEC-COMPOSITE-PASSKEY-RATE-LIMIT
 */
export function passkeyAnonymousRateLimitScope(ctx: PasskeyRateLimitContext): string {
  return ctx.projectKey ? `project:${ctx.projectKey}` : rateLimitSubject(ctx.ip);
}

/**
 * Login-begin limits. Project WS callers cannot widen their budget: the per-project rule always applies,
 * and the service's client hint only adds a narrower rule inside it. REST never limits by the email alone:
 * anyone could then lock a chosen account out by sending its address repeatedly.
 * @implements SPEC-COMPOSITE-PASSKEY-RATE-LIMIT
 */
export function passkeyLoginRateLimits(email: string, ctx: PasskeyRateLimitContext): RateLimitRule[] {
  if (ctx.projectKey) {
    const project = passkeyAnonymousRateLimitScope(ctx);
    const rules: RateLimitRule[] = [{ key: `passkey-login:${project}`, max: LOGIN_PER_PROJECT, windowSecs: LOGIN_WINDOW_SECS }];
    if (ctx.clientHint) {
      rules.push({ key: `passkey-login:${project}:client:${ctx.clientHint}`, max: LOGIN_PER_ACCOUNT_AND_IP, windowSecs: LOGIN_WINDOW_SECS });
    }
    return rules;
  }
  const ip = rateLimitSubject(ctx.ip);
  const rules: RateLimitRule[] = [{ key: `passkey-login:ip:${ip}`, max: LOGIN_PER_IP, windowSecs: LOGIN_WINDOW_SECS }];
  if (email) {
    rules.push({ key: `passkey-login:account:${email.toLowerCase()}:ip:${ip}`, max: LOGIN_PER_ACCOUNT_AND_IP, windowSecs: LOGIN_WINDOW_SECS });
  }
  return rules;
}
