/**
 * 許可の保存 — 同意の行と監査、推奨の拒否の反映、入力項目の書き込みを 1 か所で行う。
 * /consent (ticket-flow.ts) と「サービスの権限」(command.ts) の両方が使う。
 *
 * 入力項目 (fields) は同意の保存と同じトランザクションで書く
 * (spec/plan/2026-10-15-service-signup-fields-design.md §4.1)。
 */

import { logAuthEvent } from "../logging/auth-logger.js";
import { applyConsentDenials } from "./denial-sync.js";
import type { ResolvedConsentSubject } from "./project-resolver.js";
import { getConsentRecord, saveConsent, type FieldsDecision } from "./store.js";

export interface GrantDecision {
  version: number;
  granted: string[];
  denied: string[];
}

export async function saveGrant(
  userId: string,
  resolved: ResolvedConsentSubject,
  decision: GrantDecision,
  fields: FieldsDecision | null,
  eventDecision: "grant" | "update",
): Promise<void> {
  const existing = await getConsentRecord(userId, resolved.subject);
  const action = existing ? "update" : "grant";
  if (fields) await saveConsent(userId, resolved.subject, action, decision, fields);
  else await saveConsent(userId, resolved.subject, action, decision);
  await applyConsentDenials(userId, resolved.subject, { granted: decision.granted, denied: decision.denied });
  logAuthEvent({ event: "consent.decided", userId, projectKey: resolved.subject.key, decision: eventDecision });
  if (!fields) return;
  const { afterSignupFieldsSaved } = await import("../signup-fields/submission.js");
  await afterSignupFieldsSaved(userId, resolved);
  logAuthEvent({ event: "signup_fields.saved", userId, projectKey: resolved.subject.key });
}
