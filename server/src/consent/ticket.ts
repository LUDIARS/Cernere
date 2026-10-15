/**
 * consentTicket — 同意待ちのログインを /consent まで運ぶ短命 (10 分) の記録 (設計書 §4.2)。
 *
 * 継続先 (continuation) と対象サービスは発行時に検証した値だけを入れる。/consent は ticket の
 * id だけを受け取り、継続先をクエリから受け取らない (open redirect 防止)。
 * 使い切り: 判断 (許可 / 拒否) の時点で消す。Redis のキーには ticket の digest だけを使う。
 */

import { createHash, randomBytes } from "node:crypto";
import { redis } from "../redis.js";
import type { AuthenticationEvidence } from "../lib/authentication-evidence.js";
import type { ConsentContinuation } from "./continuation.js";
import type { ConsentSubject } from "./store.js";

export const CONSENT_TICKET_TTL_SECONDS = 10 * 60;

/** 同意後に authCode を出すための、ログイン成立時点の本人情報 (issueAuthCode の入力)。 */
export interface TicketAuthUser {
  userId: string;
  displayName: string;
  email: string | null;
  role: string;
  authentication?: AuthenticationEvidence;
  authEpoch?: number;
  deviceId?: string;
}

/**
 * browser: Cernere 自身の画面 (popup / ダッシュボード) が受け取った ticket。
 * service: サービスの backend を経由して渡った ticket (project WS / edge)。サービスに代理で
 *          同意させないため、判断には本人の Cernere セッションを要求する。
 */
export type ConsentChannel = "browser" | "service";

export interface ConsentTicket {
  authUser: TicketAuthUser;
  subject: ConsentSubject;
  continuation: ConsentContinuation | null;
  channel: ConsentChannel;
  declarationVersion: number;
  /** false: 同意後は継続先へ戻すだけ (edge: Hub がアサーションを再送して authCode を得る) */
  deliverAuthCode: boolean;
  createdAt: number;
}

function ticketKey(ticket: string): string {
  return `consent-ticket:${createHash("sha256").update(ticket).digest("base64url")}`;
}

function isTicketShape(ticket: string): boolean {
  return /^[A-Za-z0-9_-]{32,128}$/.test(ticket);
}

export async function createConsentTicket(record: Omit<ConsentTicket, "createdAt">): Promise<string> {
  const ticket = randomBytes(32).toString("base64url");
  await redis.set(ticketKey(ticket), JSON.stringify({ ...record, createdAt: Date.now() }), "EX", CONSENT_TICKET_TTL_SECONDS);
  return ticket;
}

function parse(raw: string | null): ConsentTicket | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as ConsentTicket; } catch { return null; }
}

export async function getConsentTicket(ticket: string): Promise<ConsentTicket | null> {
  if (!isTicketShape(ticket)) return null;
  return parse(await redis.get(ticketKey(ticket)));
}

/** 取得と削除を 1 コマンドで行う (並行した二重の判断で authCode を 2 つ出さない)。 */
export async function consumeConsentTicket(ticket: string): Promise<ConsentTicket | null> {
  if (!isTicketShape(ticket)) return null;
  return parse(await redis.getdel(ticketKey(ticket)));
}
