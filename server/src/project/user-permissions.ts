import { AppError } from "../error.js";
import { resolveProjectSubject } from "../consent/project-resolver.js";
import { evaluateForUser } from "../consent/gate.js";
import { deniedPermissionKeys } from "../consent/denials.js";

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
    permissions: declared.map(permission => ({
      key: permission.key,
      allowed: requirement.satisfied && !denied.has(permission.key)
        && (permission.decision === "granted" || !requirement.view.declared),
      purpose: permission.purpose,
    })),
  };
}
