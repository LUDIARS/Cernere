/**
 * /consent 画面の表示と判断 (consentTicket 経由、設計書 §4.2 / §4.3)。
 *
 * 判断の権限:
 *   - channel = browser: Cernere 自身の画面 (Origin) から、または本人の Cernere セッション
 *   - channel = service: 本人の Cernere セッションが必須 (サービスの backend に代理で同意させない)
 * 継続先は ticket に入っている発行時に検証済みの値だけを使う。
 */

import { AppError } from "../error.js";
import { logAuthEvent } from "../logging/auth-logger.js";
import { completeContinuation, type ContinuationOutcome } from "./continuation.js";
import { applyConsentDenials } from "./denial-sync.js";
import { evaluateForUser } from "./gate.js";
import { resolveConsentSubject } from "./project-resolver.js";
import { resolveDecision, type ConsentView } from "./requirement.js";
import { getConsentRecord, recordDenial, saveConsent } from "./store.js";
import { consumeConsentTicket, getConsentTicket, type ConsentTicket } from "./ticket.js";

export const CONSENT_SESSION_REQUIRED = "consent_session_required";

export interface ConsentViewer {
  /** 検証済みの Cernere セッションの userId (無ければ undefined) */
  userId?: string;
  /** 要求元が Cernere 自身の画面か */
  fromCernereFrontend: boolean;
}

export interface TicketDescription {
  serviceName: string;
  subjectKind: ConsentTicket["subject"]["kind"];
  view: ConsentView;
  satisfied: boolean;
}

function assertViewer(ticket: ConsentTicket, viewer: ConsentViewer): void {
  if (viewer.userId !== undefined && viewer.userId !== ticket.authUser.userId) {
    throw AppError.withCode(403, CONSENT_SESSION_REQUIRED, "Signed in as a different user than the one who is logging in");
  }
  if (viewer.userId === ticket.authUser.userId) return;
  if (ticket.channel === "browser" && viewer.fromCernereFrontend) return;
  throw AppError.withCode(401, CONSENT_SESSION_REQUIRED, "Sign in to Cernere to review this service's permissions");
}

async function loadTicket(ticketId: string): Promise<ConsentTicket> {
  const ticket = await getConsentTicket(ticketId);
  if (!ticket) throw AppError.withCode(404, "consent_ticket_expired", "This consent request has expired. Sign in to the service again.");
  return ticket;
}

async function resolveTicketSubject(ticket: ConsentTicket) {
  const resolved = await resolveConsentSubject(ticket.subject);
  if (!resolved) throw AppError.withCode(404, "consent_subject_gone", "The service is no longer available");
  return resolved;
}

export async function describeConsentTicket(ticketId: string, viewer: ConsentViewer): Promise<TicketDescription> {
  const ticket = await loadTicket(ticketId);
  assertViewer(ticket, viewer);
  const resolved = await resolveTicketSubject(ticket);
  const requirement = await evaluateForUser(ticket.authUser.userId, resolved);
  return { serviceName: resolved.name, subjectKind: resolved.subject.kind, view: requirement.view, satisfied: requirement.satisfied };
}

export interface TicketDecision {
  decision: "grant" | "deny";
  /** 許可した推奨の権限キー (grant のときだけ見る) */
  recommended: readonly string[];
}

/** 判断を保存し、継続先へ渡すもの (authCode / consent_denied) を返す。ticket は使い切り。 */
export async function decideConsentTicket(ticketId: string, input: TicketDecision, viewer: ConsentViewer): Promise<ContinuationOutcome> {
  const peeked = await loadTicket(ticketId);
  assertViewer(peeked, viewer);
  const ticket = await consumeConsentTicket(ticketId);
  if (!ticket) throw AppError.withCode(409, "consent_ticket_used", "This consent request was already answered");
  const userId = ticket.authUser.userId;
  const resolved = await resolveTicketSubject(ticket);
  const requirement = await evaluateForUser(userId, resolved);

  if (input.decision === "deny") {
    await recordDenial(userId, resolved.subject, {
      version: requirement.view.version, granted: [], denied: requirement.missingRequired,
    });
    logAuthEvent({ event: "consent.decided", userId, projectKey: resolved.subject.key, decision: "deny" });
    return completeContinuation(ticket.continuation, { denied: true });
  }

  const decision = resolveDecision(requirement, input.recommended);
  const existing = await getConsentRecord(userId, resolved.subject);
  await saveConsent(userId, resolved.subject, existing ? "update" : "grant", { version: requirement.view.version, ...decision });
  await applyConsentDenials(userId, resolved.subject, decision);
  logAuthEvent({ event: "consent.decided", userId, projectKey: resolved.subject.key, decision: "grant" });

  // 渡し先が無い ticket では authCode を作らない (作っても誰にも届かず refresh 行だけが残る)。
  // 利用者はサービスへ戻ってログインし直す。edge は Hub がアサーションを再送する。
  if (!ticket.deliverAuthCode || !ticket.continuation) return completeContinuation(ticket.continuation, { authCode: null });
  // 同意を保存したので関門は通る (版がこの間に上がっていれば再び consent_required になる)。
  const { issueAuthCode } = await import("../auth/auth-code.js");
  const authCode = await issueAuthCode({
    ...ticket.authUser,
    service: { subject: { projectKey: resolved.subject.key }, channel: ticket.channel },
  });
  const { ensureUserProjectRow } = await import("../project/service.js");
  await ensureUserProjectRow(userId, resolved.subject.key);
  return completeContinuation(ticket.continuation, { authCode });
}
