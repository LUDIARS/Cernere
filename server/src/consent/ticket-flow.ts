/**
 * /consent 画面の表示と判断 (consentTicket 経由、設計書 §4.2 / §4.3)。
 *
 * 判断の権限:
 *   - channel = browser: Cernere 自身の画面 (Origin) から、または本人の Cernere セッション
 *   - channel = service: 本人の Cernere セッションが必須 (サービスの backend に代理で同意させない)
 * 継続先は ticket に入っている発行時に検証済みの値だけを使う。
 *
 * 入力項目 (signup_fields) を宣言したサービスは、権限と入力値を同じ判断で受け取り、同意の保存と同じ
 * トランザクションで行に書く (spec/plan/2026-10-15-service-signup-fields-design.md §4.1)。
 * 入力の誤りは ticket を消費する前に返す (直して送り直せる)。
 */

import { AppError } from "../error.js";
import { logAuthEvent } from "../logging/auth-logger.js";
import { completeContinuation, type ContinuationOutcome } from "./continuation.js";
import { saveGrant } from "./grant.js";
import { evaluateForUser } from "./gate.js";
import { resolveConsentSubject, type ResolvedConsentSubject } from "./project-resolver.js";
import { resolveDecision, type ConsentView } from "./requirement.js";
import { getConsentRecord, recordDenial, type FieldsDecision } from "./store.js";
import type { SignupFieldView } from "../signup-fields/requirement.js";
import { consumeConsentTicket, getConsentTicket, type ConsentTicket } from "./ticket.js";
import { serviceSubjectId } from "../federation/subject.js";

export const CONSENT_SESSION_REQUIRED = "consent_session_required";

export interface ConsentViewer {
  /** 検証済みの Cernere セッションの userId (無ければ undefined) */
  userId?: string;
  /** 要求元が Cernere 自身の画面か */
  fromCernereFrontend: boolean;
}

export interface SignupFieldsDescription {
  version: number;
  /** この画面で聞く項目 (未入力の必須と、まだ見せていない未入力の任意) */
  fields: SignupFieldView[];
}

export interface TicketDescription {
  serviceName: string;
  subjectKind: ConsentTicket["subject"]["kind"];
  view: ConsentView;
  satisfied: boolean;
  /** 入力項目。宣言の無いサービスは null */
  signupFields: SignupFieldsDescription | null;
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

async function resolveTicketSubject(ticket: ConsentTicket): Promise<ResolvedConsentSubject> {
  const resolved = await resolveConsentSubject(ticket.subject);
  if (!resolved) throw AppError.withCode(404, "consent_subject_gone", "The service is no longer available");
  return resolved;
}

export async function describeConsentTicket(ticketId: string, viewer: ConsentViewer): Promise<TicketDescription> {
  const ticket = await loadTicket(ticketId);
  assertViewer(ticket, viewer);
  const resolved = await resolveTicketSubject(ticket);
  // 同意記録・サインアップ入力は連携番号で持つ (account-federation §3)。
  const userId = await serviceSubjectId(ticket.authUser.userId);
  const requirement = await evaluateForUser(userId, resolved);
  return {
    serviceName: resolved.name,
    subjectKind: resolved.subject.kind,
    view: requirement.view,
    satisfied: requirement.satisfied,
    signupFields: await describeSignupFields(userId, resolved),
  };
}

async function describeSignupFields(userId: string, resolved: ResolvedConsentSubject): Promise<SignupFieldsDescription | null> {
  if (!resolved.signupFields) return null;
  const { evaluateSignupFieldsForUser } = await import("../signup-fields/evaluate.js");
  const fields = await evaluateSignupFieldsForUser(userId, resolved, await getConsentRecord(userId, resolved.subject));
  return { version: fields.version, fields: fields.fields };
}

export interface TicketDecision {
  decision: "grant" | "deny";
  /** 許可した推奨の権限キー (grant のときだけ見る) */
  recommended: readonly string[];
  /** 入力項目の値 (列名 → 値)。grant のときだけ見る */
  fields?: Readonly<Record<string, unknown>>;
}

/** 入力項目の保存内容。誤りがあれば SignupFieldsInvalidError (何も保存しない)。 */
async function prepareFields(
  userId: string,
  resolved: ResolvedConsentSubject,
  decision: { granted: string[]; denied: string[] },
  input: Readonly<Record<string, unknown>>,
): Promise<FieldsDecision | null> {
  if (!resolved.signupFields) return null;
  const { prepareConsentFields } = await import("../signup-fields/submission.js");
  return prepareConsentFields(userId, resolved, decision, input, "asked");
}

/** 判断を保存し、継続先へ渡すもの (authCode / consent_denied) を返す。ticket は使い切り。 */
export async function decideConsentTicket(ticketId: string, input: TicketDecision, viewer: ConsentViewer): Promise<ContinuationOutcome> {
  const peeked = await loadTicket(ticketId);
  assertViewer(peeked, viewer);
  // 同意記録・サインアップ入力は連携番号で持つ (account-federation §3)。authCode はログインしたアカウントで出す。
  const userId = await serviceSubjectId(peeked.authUser.userId);
  const resolved = await resolveTicketSubject(peeked);
  const requirement = await evaluateForUser(userId, resolved);
  const decision = input.decision === "grant" ? resolveDecision(requirement, input.recommended) : null;
  // 入力の誤りは ticket を使い切る前に返す (利用者が直して送り直せるように)。
  const fields = decision ? await prepareFields(userId, resolved, decision, input.fields ?? {}) : null;

  const ticket = await consumeConsentTicket(ticketId);
  if (!ticket) throw AppError.withCode(409, "consent_ticket_used", "This consent request was already answered");

  if (!decision) {
    await recordDenial(userId, resolved.subject, {
      version: requirement.view.version, granted: [], denied: requirement.missingRequired,
    });
    logAuthEvent({ event: "consent.decided", userId, projectKey: resolved.subject.key, decision: "deny" });
    return completeContinuation(ticket.continuation, { denied: true });
  }

  await saveGrant(userId, resolved, { version: requirement.view.version, ...decision }, fields, "grant");

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
