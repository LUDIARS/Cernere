import { AppError } from "../error.js";
import { resolveProjectSubject } from "../consent/project-resolver.js";
import { evaluateForUser } from "../consent/gate.js";
import { deniedPermissionKeys } from "../consent/denials.js";

const MODULE_PERMISSION_PREFIX = "user_data.module:";

/**
 * 利用者の判断の状態。サービスが「本人が断った」と「まだ決めていない」を見分けて案内を変えるために返す。
 * - granted: 許可されていて、いま使える
 * - denied: 本人が拒否 (opt-out) している。再ログインしても聞き直されない。Cernere の権限画面でしか戻せない
 * - undecided: 未同意・宣言の未確認・サービスの利用停止など、明示の拒否ではないが使えない
 */
export type ProjectPermissionState = "granted" | "denied" | "undecided";

/** 拒否された権限キーのうち user_data の module だけを、module 名で並べる (宣言外の module も含む)。 */
export function optedOutModulesOf(denied: Iterable<string>): string[] {
  const modules = new Set<string>();
  for (const key of denied) {
    if (key.startsWith(MODULE_PERMISSION_PREFIX)) modules.add(key.slice(MODULE_PERMISSION_PREFIX.length));
  }
  return [...modules].sort();
}

/** Read only the calling project's effective consent; never changes user decisions.
 * @implements SPEC-PROJECT-USER-PERMISSIONS-001
 */
export async function getProjectUserPermissions(projectKey: string, userId: string) {
  const subject = await resolveProjectSubject(projectKey);
  if (!subject) throw AppError.notFound("Project not found");
  const [requirement, denied] = await Promise.all([
    evaluateForUser(userId, subject),
    deniedPermissionKeys(userId, projectKey),
  ]);
  const declared = [...requirement.view.required, ...requirement.view.recommended];
  return {
    permissions: declared.map(permission => {
      const allowed = requirement.satisfied && !denied.has(permission.key)
        && (permission.decision === "granted" || !requirement.view.declared);
      const state: ProjectPermissionState = denied.has(permission.key) ? "denied" : allowed ? "granted" : "undecided";
      return { key: permission.key, allowed, state, purpose: permission.purpose };
    }),
    optedOutModules: optedOutModulesOf(denied),
  };
}
