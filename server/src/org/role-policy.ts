/**
 * 組織内ロールの権限規則 (純粋関数のみ)。
 *
 * - leader: 組織内の管理 (メンバーの追加・削除、member⇔leader の変更、組織サービスの有効化、
 *   メンバーのメール閲覧) ができる。owner/admin/maintainer の付与・解除はできない。
 * - 自分より上位のロールは誰にも付けられず、上位のメンバーは変更・削除できない
 *   (以前は maintainer が owner を付与できた)。
 * - system admin は非メンバーでも全ロールを扱える (最初の leader の指名に使う)。
 */
export const ORG_ROLES = ["owner", "admin", "maintainer", "leader", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** 呼び出し元の立場。組織メンバーのロールか、非メンバーの system admin。 */
export type OrgActor = OrgRole | "system_admin";

const RANK: Record<OrgActor, number> = {
  system_admin: 5,
  owner: 4,
  admin: 3,
  maintainer: 3,
  leader: 2,
  member: 1,
};

/** 組織内の管理 (メンバー管理・組織サービス・メール閲覧) ができるロール。 */
export const ORG_MANAGER_ROLES: readonly OrgRole[] = ["owner", "admin", "maintainer", "leader"];

export function isOrgRole(value: string): value is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(value);
}

function rank(role: string): number {
  return RANK[role as OrgActor] ?? 0;
}

export function canManageOrg(actor: string): boolean {
  return actor === "system_admin" || (ORG_MANAGER_ROLES as readonly string[]).includes(actor);
}

/** actor が付けられるロールの一覧 (UI の選択肢と server 検証で共通に使う)。 */
export function assignableRoles(actor: string): OrgRole[] {
  if (!canManageOrg(actor)) return [];
  return ORG_ROLES.filter((role) => rank(role) <= rank(actor));
}

export type RoleDecision = { ok: true } | { ok: false; reason: string };

/** メンバーの追加 (role 付き) を許すか。 */
export function decideAdd(actor: string, role: string): RoleDecision {
  if (!canManageOrg(actor)) return { ok: false, reason: "Insufficient organization permissions" };
  if (!isOrgRole(role)) return { ok: false, reason: `Unknown organization role: ${role}` };
  if (!assignableRoles(actor).includes(role)) return { ok: false, reason: "Cannot assign a role above your own" };
  return { ok: true };
}

/** 既存メンバーのロール変更を許すか。target は変更前のロール。 */
export function decideRoleChange(actor: string, target: string, next: string): RoleDecision {
  const base = decideAdd(actor, next);
  if (!base.ok) return base;
  if (rank(target) > rank(actor)) return { ok: false, reason: "Cannot change a member ranked above you" };
  return { ok: true };
}

/** 他メンバーの削除を許すか (自己退出は常に可で、ここには来ない)。 */
export function decideRemove(actor: string, target: string): RoleDecision {
  if (!canManageOrg(actor)) return { ok: false, reason: "Insufficient organization permissions" };
  if (rank(target) > rank(actor)) return { ok: false, reason: "Cannot remove a member ranked above you" };
  return { ok: true };
}
