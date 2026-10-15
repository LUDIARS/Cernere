/**
 * OIDC authorize の同意 (設計書 §4.2 の OIDC 行)。
 *
 * OIDC は自前の authorize リクエスト (oidc/store.ts) と /oidc/consent 画面を持つので consentTicket を
 * 使わない。画面の表示データと判定は他経路と同じ requirement.ts を使う。
 *   - consent_mode off: 従来どおり (保存しない・毎回画面を出す・要求 scope をそのまま渡す)
 *   - warn / enforce: 判断を保存し、保存済みなら画面を省略できる。拒否した scope は渡さない
 */

import { AppError } from "../error.js";
import { logAuthEvent } from "../logging/auth-logger.js";
import { CONSENT_REQUIRED, evaluateForUser } from "./gate.js";
import { decideConsentGate } from "./gate-policy.js";
import { consentServiceId, deniedPermissionKeys, filterDeniedOidcScopes } from "./denials.js";
import { applyConsentDenials } from "./denial-sync.js";
import { resolveOidcSubject } from "./project-resolver.js";
import { evaluateConsentRequirement, resolveDecision, type ConsentView } from "./requirement.js";
import { getConsentRecord, saveConsent } from "./store.js";

export interface OidcConsentInfo {
  mode: "warn" | "enforce";
  /** 保存済みの同意で足りている (画面を省略してよい) */
  satisfied: boolean;
  view: ConsentView;
}

/** 同意画面の表示データ。consent_mode off は null (従来の scope 一覧を出す)。 */
export async function oidcConsentInfo(clientId: string, userId: string | null): Promise<OidcConsentInfo | null> {
  const resolved = await resolveOidcSubject(clientId);
  if (!resolved || resolved.mode === "off") return null;
  const requirement = userId
    ? await evaluateForUser(userId, resolved)
    : evaluateConsentRequirement({ declaration: resolved.declaration, caps: resolved.caps, sharing: [], record: null });
  return { mode: resolved.mode, satisfied: requirement.satisfied, view: requirement.view };
}

/**
 * 承認時に同意を確定し、RP へ渡してよい scope を返す。
 * `chosenRecommended` は利用者が許可した推奨 (画面から)。省略は「保存済みの同意で進める」。
 */
export async function settleOidcConsent(
  userId: string,
  clientId: string,
  scope: readonly string[],
  chosenRecommended?: readonly string[],
): Promise<string[]> {
  const resolved = await resolveOidcSubject(clientId);
  if (resolved && resolved.mode !== "off") {
    const record = await getConsentRecord(userId, resolved.subject);
    const requirement = evaluateConsentRequirement({
      declaration: resolved.declaration, caps: resolved.caps, sharing: [], record,
    });
    if (chosenRecommended !== undefined) {
      const decision = resolveDecision(requirement, chosenRecommended);
      await saveConsent(userId, resolved.subject, record ? "update" : "grant", { version: requirement.view.version, ...decision });
      await applyConsentDenials(userId, resolved.subject, decision);
      logAuthEvent({ event: "consent.decided", userId, clientId });
    } else if (!requirement.satisfied) {
      const action = decideConsentGate(resolved.mode, false);
      if (action === "block") throw AppError.withCode(403, CONSENT_REQUIRED, "Consent to this application's permissions is required");
      logAuthEvent({ event: "consent.would_block", userId, clientId });
    }
  }
  return withoutDeniedScopes(userId, clientId, scope);
}

/** 利用者が拒否している scope を除く (token / userinfo でも毎回確かめる。後からの取り消しに追従する)。 */
export async function withoutDeniedScopes(userId: string, clientId: string, scope: readonly string[]): Promise<string[]> {
  const denied = await deniedPermissionKeys(userId, consentServiceId({ kind: "oidc_client", key: clientId }));
  return filterDeniedOidcScopes(scope, denied);
}
