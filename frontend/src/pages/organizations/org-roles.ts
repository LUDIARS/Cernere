/**
 * 組織ロールの表示用規則。server/src/org/role-policy.ts と同じ順位を持つ (テストで一致を確かめる)。
 * ここは選択肢の出し分けだけで、可否は server が判定する。
 */
export const ORG_ROLE_OPTIONS = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "maintainer", label: "Maintainer" },
  { value: "leader", label: "リーダー" },
  { value: "member", label: "Member" },
] as const;

const RANK: Record<string, number> = { system_admin: 5, owner: 4, admin: 3, maintainer: 3, leader: 2, member: 1 };
const MANAGERS = ["system_admin", "owner", "admin", "maintainer", "leader"];

export function roleRank(role: string | undefined): number {
  return RANK[role ?? ""] ?? 0;
}

export function canManageMembers(actor: string | undefined): boolean {
  return !!actor && MANAGERS.includes(actor);
}

/** actor が付けられるロール。 */
export function assignableRoleValues(actor: string | undefined): string[] {
  if (!canManageMembers(actor)) return [];
  return ORG_ROLE_OPTIONS.map((o) => o.value).filter((role) => roleRank(role) <= roleRank(actor));
}

/** actor がこのメンバーのロール変更・削除をできるか (自分自身は対象外)。 */
export function canEditMember(actor: string | undefined, targetRole: string, isSelf: boolean): boolean {
  return !isSelf && canManageMembers(actor) && roleRank(targetRole) <= roleRank(actor);
}
