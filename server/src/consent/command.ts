/**
 * WS module "consent" — 本人の「サービスの権限」(/data-optout) 用 (設計書 §4.3 / §7.2)。
 *
 *   consent.list    同意したサービスと権限ごとの判断
 *   consent.get     1 サービスの表示データ
 *   consent.decide  推奨の許可 / 取り消しと入力項目の値を変える (action proof: consent.decide)
 *                   入力の誤りは { fieldErrors } を返し、何も保存しない
 *   consent.revoke  同意を取り消す = そのサービスの利用停止 (action proof: consent.revoke)
 *
 * ログイン途中の同意は consentTicket (ticket-flow.ts) が扱う。ここは利用開始後の見直し。
 */

import { z } from "zod";
import { AppError } from "../error.js";
import { logAuthEvent } from "../logging/auth-logger.js";
import { applyConsentDenials } from "./denial-sync.js";
import { saveGrant } from "./grant.js";
import { evaluateForUser } from "./gate.js";
import { IDENTITY_BASIC } from "./permission-keys.js";
import { resolveConsentSubject, type ResolvedConsentSubject } from "./project-resolver.js";
import { resolveDecision } from "./requirement.js";
import { getConsentRecord, listConsentRecords, revokeConsent, type ConsentSubject, type FieldsDecision } from "./store.js";
import { SignupFieldsInvalidError } from "../signup-fields/errors.js";

const subjectSchema = z.object({
  subjectKind: z.enum(["project", "oidc_client"]),
  subjectKey: z.string().min(1).max(128),
});
const decideSchema = subjectSchema.extend({
  recommended: z.array(z.string().max(160)).max(100),
  fields: z.record(z.string().max(128), z.unknown()).optional(),
}).strict();

function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload ?? {});
  if (!parsed.success) throw AppError.badRequest("subjectKind, subjectKey (and recommended) are required");
  return parsed.data;
}

async function resolveOrThrow(subject: ConsentSubject): Promise<ResolvedConsentSubject> {
  const resolved = await resolveConsentSubject(subject);
  if (!resolved) throw AppError.notFound("Service not found or inactive");
  return resolved;
}

/** プロフィールの見直しでは、聞ける全項目を現在の値つきで見せる。 */
async function describeSignupFields(userId: string, resolved: ResolvedConsentSubject, record: Awaited<ReturnType<typeof getConsentRecord>>) {
  if (!resolved.signupFields) return null;
  const { evaluateSignupFieldsForUser } = await import("../signup-fields/evaluate.js");
  const fields = await evaluateSignupFieldsForUser(userId, resolved, record);
  return { version: fields.version, fields: fields.all };
}

async function prepareFields(
  userId: string,
  resolved: ResolvedConsentSubject,
  decision: { granted: string[]; denied: string[] },
  input: Readonly<Record<string, unknown>> | undefined,
): Promise<FieldsDecision | null> {
  if (!resolved.signupFields || !input) return null;
  const { prepareConsentFields } = await import("../signup-fields/submission.js");
  return prepareConsentFields(userId, resolved, decision, input, "all");
}

async function describe(userId: string, resolved: ResolvedConsentSubject) {
  const requirement = await evaluateForUser(userId, resolved);
  const record = await getConsentRecord(userId, resolved.subject);
  return {
    subjectKind: resolved.subject.kind,
    subjectKey: resolved.subject.key,
    serviceName: resolved.name,
    mode: resolved.mode,
    decidedAt: record?.decidedAt ?? null,
    revokedAt: record?.revokedAt ?? null,
    satisfied: requirement.satisfied,
    view: requirement.view,
    signupFields: await describeSignupFields(userId, resolved, record),
  };
}

export async function consentCommand(userId: string, action: string, payload?: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case "list": {
      const records = await listConsentRecords(userId);
      const items = [];
      for (const record of records) {
        const resolved = await resolveConsentSubject(record.subject);
        if (resolved) items.push(await describe(userId, resolved));
      }
      return items;
    }
    case "get": {
      const p = parse(subjectSchema, payload);
      return describe(userId, await resolveOrThrow({ kind: p.subjectKind, key: p.subjectKey }));
    }
    case "decide": {
      const p = parse(decideSchema, payload);
      const resolved = await resolveOrThrow({ kind: p.subjectKind, key: p.subjectKey });
      const requirement = await evaluateForUser(userId, resolved);
      const decision = resolveDecision(requirement, p.recommended);
      let fields: FieldsDecision | null;
      try {
        fields = await prepareFields(userId, resolved, decision, p.fields);
      } catch (error) {
        // WS のエラー応答は message しか運べないので、項目ごとの誤りは通常の応答で返す。
        if (error instanceof SignupFieldsInvalidError) return { fieldErrors: error.fieldErrors };
        throw error;
      }
      await saveGrant(userId, resolved, { version: requirement.view.version, ...decision }, fields, "update");
      return describe(userId, resolved);
    }
    case "revoke": {
      const p = parse(subjectSchema, payload);
      const resolved = await resolveOrThrow({ kind: p.subjectKind, key: p.subjectKey });
      const requirement = await evaluateForUser(userId, resolved);
      if (!await revokeConsent(userId, resolved.subject, requirement.view.version)) {
        throw AppError.notFound("No consent to revoke for this service");
      }
      // 利用停止: identity.basic 以外は全て渡さない (推奨の拒否と同じ表に載せる)。
      const keys = [...requirement.view.required, ...requirement.view.recommended].map((v) => v.key)
        .filter((key) => key !== IDENTITY_BASIC);
      await applyConsentDenials(userId, resolved.subject, { granted: [], denied: keys });
      logAuthEvent({ event: "consent.decided", userId, projectKey: resolved.subject.key, decision: "revoke" });
      return describe(userId, resolved);
    }
    default:
      throw AppError.badRequest(`Unknown consent action: ${action}`);
  }
}
