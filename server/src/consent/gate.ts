/**
 * サービス向け authCode の発行前に置く同意の関門 (設計書 §4.1 / §6)。
 *
 * issueAuthCode (audience = "service") が requireActiveUser の直後に呼ぶ。対象サービスを解決し、
 * consent_mode に従って判定する。enforce で未充足なら authCode を出さず ConsentRequiredError
 * (consentTicket と /consent の URL 付き) を投げる。各経路はそれを consent_required 応答へ変える。
 *
 * 入力項目 (signup_fields、spec/plan/2026-10-15-service-signup-fields-design.md §3) を宣言したサービスは、
 * 必須が未入力なら consent_mode に関係なく同じ ConsentRequiredError で /consent へ送る
 * (応答のコードは consent_required のまま)。任意だけの未入力では止めない。
 */

import { config } from "../config.js";
import { AppError } from "../error.js";
import { compositeAllowedOrigins } from "../auth/composite-redirect.js";
import { logAuthEvent } from "../logging/auth-logger.js";
import { devLog } from "../logging/dev-logger.js";
import { buildConsentContinuation, type ConsentContinuation, type ContinuationRequest } from "./continuation.js";
import { decideConsentGate } from "./gate-policy.js";
import { resolveProjectSubject, resolveSubjectByOrigin, type ResolvedConsentSubject } from "./project-resolver.js";
import { evaluateConsentRequirement, type ConsentRequirement } from "./requirement.js";
import { serviceSubjectId } from "../federation/subject.js";
import { getConsentRecord } from "./store.js";
import { createConsentTicket, type ConsentChannel, type TicketAuthUser } from "./ticket.js";

export const CONSENT_REQUIRED = "consent_required";
export const CONSENT_DENIED = "consent_denied";

/** サービス向け authCode の対象。全経路が必ず渡す (渡せない経路は subject: null と理由)。 */
export interface ServiceConsentRequest {
  subject: { projectKey: string } | { origin: string } | null;
  /** 同意後にどこへ戻すか (未検証。関門が許可 origin で検証する) */
  continuation?: ContinuationRequest | null;
  channel: ConsentChannel;
  /** 同意後に authCode を出すか。既定 true */
  deliverAuthCode?: boolean;
  /**
   * 送り先の指定が無いサービス経由 (channel = service) の戻し方。既定 post_message (サービスの画面が
   * popup で開いた想定)。redirect はサービスの frontend_url の origin へ同一窓で戻す (edge)。
   */
  defaultContinuation?: "post_message" | "redirect";
  /** subject: null のときの理由 (ログ用) */
  reason?: string;
}

export class ConsentRequiredError extends AppError {
  constructor(readonly ticket: string, readonly consentUrl: string) {
    super(403, "Consent to this service's permissions is required", CONSENT_REQUIRED);
    this.name = "ConsentRequiredError";
  }
}

/** consent_required の応答本体 (REST / WS 共通)。 */
export function consentRequiredBody(error: ConsentRequiredError): Record<string, unknown> {
  return { error: CONSENT_REQUIRED, code: CONSENT_REQUIRED, consentRequired: true, consentUrl: error.consentUrl };
}

export function consentPageUrl(ticket: string): string {
  return `${config.frontendUrl.replace(/\/+$/, "")}/consent?ticket=${encodeURIComponent(ticket)}`;
}

async function resolveRequestSubject(request: ServiceConsentRequest): Promise<ResolvedConsentSubject | null> {
  if (!request.subject) return null;
  return "projectKey" in request.subject
    ? resolveProjectSubject(request.subject.projectKey)
    : resolveSubjectByOrigin(request.subject.origin);
}

/** 利用者 × サービスの要件を評価する (関門・同意画面・権限ページで共通)。 */
export async function evaluateForUser(userId: string, resolved: ResolvedConsentSubject): Promise<ConsentRequirement> {
  const record = await getConsentRecord(userId, resolved.subject);
  return evaluateConsentRequirement({
    declaration: resolved.declaration,
    caps: resolved.caps,
    sharing: resolved.sharing,
    record,
  });
}

function resolveContinuation(request: ServiceConsentRequest, resolved: ResolvedConsentSubject): ConsentContinuation | null {
  const allowed = [...new Set([...compositeAllowedOrigins(), ...(resolved.frontendOrigin ? [resolved.frontendOrigin] : [])])];
  if (request.continuation) return buildConsentContinuation(request.continuation, allowed);
  // サービス経由 (project WS / edge) で送り先の指定が無ければ、サービスの画面 (frontend_url) へ戻す。
  if (request.channel === "service" && resolved.frontendOrigin) {
    return request.defaultContinuation === "redirect"
      ? { kind: "redirect", url: `${resolved.frontendOrigin}/` }
      : { kind: "post_message", origin: resolved.frontendOrigin };
  }
  return null;
}

/** 入力項目の必須に未入力があるか。宣言の無いサービスは本人の行を読まない。 */
async function hasMissingSignupFields(userId: string, resolved: ResolvedConsentSubject): Promise<boolean> {
  if (!resolved.signupFields) return false;
  const { evaluateSignupFieldsForUser } = await import("../signup-fields/evaluate.js");
  // 必須の判定は見せた記録 (fields_version) に依らないので同意の行は読まない。
  return (await evaluateSignupFieldsForUser(userId, resolved, null)).missingRequired.length > 0;
}

export async function enforceServiceConsent(authUser: TicketAuthUser, request: ServiceConsentRequest): Promise<void> {
  const resolved = await resolveRequestSubject(request);
  if (!resolved) {
    devLog("consent.gate.noSubject", { userId: authUser.userId, reason: request.reason ?? "unresolved" });
    return;
  }
  // 同意記録・サインアップ入力は連携番号で持つ (account-federation §3)。ticket はログインしたアカウントのまま。
  const subjectId = await serviceSubjectId(authUser.userId);
  const fieldsMissing = await hasMissingSignupFields(subjectId, resolved);
  if (resolved.mode === "off" && !fieldsMissing) return;

  const requirement = await evaluateForUser(subjectId, resolved);
  const action = fieldsMissing ? "block" : decideConsentGate(resolved.mode, requirement.satisfied);
  if (action === "pass") return;
  if (action === "warn") {
    logAuthEvent({ event: "consent.would_block", userId: authUser.userId, projectKey: resolved.subject.key });
    return;
  }

  const ticket = await createConsentTicket({
    authUser,
    subject: resolved.subject,
    continuation: resolveContinuation(request, resolved),
    channel: request.channel,
    declarationVersion: requirement.view.version,
    deliverAuthCode: request.deliverAuthCode ?? true,
  });
  logAuthEvent({
    event: fieldsMissing ? "signup_fields.required" : "consent.required",
    userId: authUser.userId,
    projectKey: resolved.subject.key,
  });
  throw new ConsentRequiredError(ticket, consentPageUrl(ticket));
}
