/**
 * 入力値の受け付け (設計書 §4.1 / §4.2)。
 *
 *   /consent の「許可して続ける」 — 同意の保存と同じトランザクションで書く (prepareConsentFields)
 *   サービスの権限 (プロフィール)  — 同上。聞ける全項目を直せる
 *   オンボーディング               — 同意の行はまだ無いので値だけ書く (saveSignupFields)
 *
 * 1 項目でも誤りがあれば SignupFieldsInvalidError (項目ごとのエラー) を投げ、何も保存しない。
 */

import { AppError } from "../error.js";
import { db } from "../db/connection.js";
import type { ResolvedConsentSubject } from "../consent/project-resolver.js";
import { getConsentRecord, type FieldsDecision } from "../consent/store.js";
import { invalidate as invalidateUserDataCache } from "../project/user-data-cache.js";
import { SignupFieldsInvalidError } from "./errors.js";
import { evaluateSignupFieldsForUser, type PendingConsentDecision } from "./evaluate.js";
import type { SignupFieldsRequirement } from "./requirement.js";
import { writeSignupValueGroups } from "./store.js";
import { valuesByTable } from "./targets.js";
import { validateSignupFieldValues } from "./values.js";

/** asked: 画面で聞いた項目だけ (/consent・オンボーディング) / all: 聞ける全項目 (プロフィールの見直し) */
export type SignupFieldsScope = "asked" | "all";

function targetsOf(requirement: SignupFieldsRequirement, scope: SignupFieldsScope) {
  return scope === "asked" ? requirement.fields : requirement.all;
}

/** 検証済みの値を保存先表 (自分 / 共有元) ごとに分ける (設計書 §8.2)。 */
function groupsOf(resolved: ResolvedConsentSubject, table: string, values: Parameters<typeof valuesByTable>[0], views: SignupFieldsRequirement["all"]) {
  return valuesByTable(values, views, { projectKey: resolved.subject.key, storageTable: table }, resolved.signupSources ?? {});
}

/**
 * 同意の保存 (saveConsent) に渡す入力項目の保存内容を作る。宣言の無いサービスは null。
 * 見せた列 (fields_seen) は前回の記録に今回聞ける全列を足したもの (入力済みは聞いていないが、聞き直さない)。
 */
export async function prepareConsentFields(
  userId: string,
  resolved: ResolvedConsentSubject,
  pending: PendingConsentDecision,
  input: Readonly<Record<string, unknown>>,
  scope: SignupFieldsScope,
): Promise<FieldsDecision | null> {
  const table = resolved.storageTable;
  if (!resolved.signupFields || !table) return null;
  const record = await getConsentRecord(userId, resolved.subject);
  const requirement = await evaluateSignupFieldsForUser(userId, resolved, record, pending);
  const targets = targetsOf(requirement, scope);
  const check = validateSignupFieldValues(targets, input);
  if (!check.ok) throw new SignupFieldsInvalidError(check.errors);
  const groups = groupsOf(resolved, table, check.values, targets);
  const previous = record && !record.revoked && record.fieldsVersion !== null ? record.fieldsSeen : [];
  return {
    version: requirement.version,
    seen: [...new Set([...previous, ...requirement.all.map((f) => f.column)])],
    write: (tx) => writeSignupValueGroups(tx, userId, groups),
  };
}

/** 保存後に、サービス (と共有元 project) が読む user_data のキャッシュを捨てる。 */
export async function afterSignupFieldsSaved(userId: string, resolved: ResolvedConsentSubject): Promise<void> {
  if (!resolved.signupFields) return;
  await invalidateUserDataCache(userId, resolved.subject.key);
  for (const projectKey of Object.keys(resolved.signupSources ?? {})) await invalidateUserDataCache(userId, projectKey);
}

/** オンボーディングでの保存。画面で聞いた項目だけを書く。 */
export async function saveSignupFields(
  userId: string,
  resolved: ResolvedConsentSubject,
  input: Readonly<Record<string, unknown>>,
): Promise<SignupFieldsRequirement> {
  const table = resolved.storageTable;
  if (!resolved.signupFields || !table) throw AppError.notFound("This service does not ask for sign-up fields");
  const record = await getConsentRecord(userId, resolved.subject);
  const requirement = await evaluateSignupFieldsForUser(userId, resolved, record);
  const check = validateSignupFieldValues(requirement.fields, input);
  if (!check.ok) throw new SignupFieldsInvalidError(check.errors);
  const groups = groupsOf(resolved, table, check.values, requirement.fields);
  // 自分の表と共有元の表をまとめて書く (片方だけ残さない)。
  await db.transaction((tx) => writeSignupValueGroups(tx, userId, groups));
  await afterSignupFieldsSaved(userId, resolved);
  return evaluateSignupFieldsForUser(userId, resolved, record);
}
