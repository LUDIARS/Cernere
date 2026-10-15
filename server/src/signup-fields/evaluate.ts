/**
 * 利用者 × サービスの入力項目の要否を、本人の行・拒否 module・見せた記録から評価する (設計書 §3)。
 * 判定そのものは純粋関数 evaluateSignupFields (requirement.ts)。ここは材料を集めるだけ。
 */

import { devLog } from "../logging/dev-logger.js";
import type { ResolvedConsentSubject } from "../consent/project-resolver.js";
import type { StoredConsent } from "../consent/store.js";
import { activeColumn } from "./declaration.js";
import { evaluateSignupFields, type SignupFieldsRequirement, type SignupFieldsSeen } from "./requirement.js";
import { deniedSignupModules, loadSignupValues } from "./store.js";

const MODULE_PERMISSION_PREFIX = "user_data.module:";

/** これから保存する同意の判断 (保存前に、その判断で拒否される module の列を聞かないため)。 */
export interface PendingConsentDecision {
  granted: readonly string[];
  denied: readonly string[];
}

function modulesOf(keys: readonly string[]): string[] {
  return keys.filter((k) => k.startsWith(MODULE_PERMISSION_PREFIX)).map((k) => k.slice(MODULE_PERMISSION_PREFIX.length));
}

function seenOf(record: StoredConsent | null): SignupFieldsSeen {
  if (!record || record.revoked) return { version: null, columns: [] };
  return { version: record.fieldsVersion, columns: record.fieldsSeen };
}

export async function evaluateSignupFieldsForUser(
  userId: string,
  resolved: ResolvedConsentSubject,
  record: StoredConsent | null,
  pending?: PendingConsentDecision,
): Promise<SignupFieldsRequirement> {
  const declaration = resolved.signupFields ?? null;
  const columns = resolved.userColumns ?? {};
  const consent = resolved.declaration;
  if (!declaration || !resolved.storageTable) {
    return evaluateSignupFields({ declaration: null, columns, values: {}, deniedModules: new Set(), seen: seenOf(null), consent });
  }

  const deniedModules = await deniedSignupModules(userId, resolved.subject);
  if (pending) {
    for (const module of modulesOf(pending.granted)) deniedModules.delete(module);
    for (const module of modulesOf(pending.denied)) deniedModules.add(module);
  }

  // 識別子にするのは宣言と列定義を照合した有効な列だけ。
  const readable = declaration.fields.map((f) => f.column).filter((c) => activeColumn(columns, c) !== null);
  let values: Record<string, unknown> = {};
  try {
    values = await loadSignupValues(resolved.storageTable, userId, readable);
  } catch (err) {
    // 表が未作成等。未入力として扱う (必須があれば画面で聞き、保存時に誤りが見える)。
    devLog("signup_fields.loadFailed", { projectKey: resolved.subject.key, error: (err as Error).message });
  }
  return evaluateSignupFields({ declaration, columns, values, deniedModules, seen: seenOf(record), consent });
}
