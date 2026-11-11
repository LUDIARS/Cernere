/**
 * Cernere 管理画面のメニュー定義。一般・リーダー以上・システム管理者の 3 段に分ける。
 *
 * - 一般: 自分のデータの閲覧・修正、データの設定 (オプトアウト)、端末とログイン。
 * - リーダー以上 (どこかの組織で leader/maintainer/admin/owner): 組織。
 * - システム管理者: サービス管理と各種管理画面。管理者には一般と管理者の 2 段を出す。
 * 「利用許可」はメニューに出さない (審査待ちの人は AccessGate が自動で案内する)。
 * 権限の判定は server が行い、ここは表示の出し分けに過ぎない。
 */
export interface NavItem { path: string; label: string }

export const NAV_GENERAL: NavItem[] = [
  { path: "/", label: "データを登録しているサービス" },
  { path: "/profile", label: "自分のデータ" },
  { path: "/data-optout", label: "データの設定" },
  { path: "/devices", label: "端末とログイン" },
];

export const NAV_LEADER: NavItem[] = [
  { path: "/organizations", label: "組織" },
];

export const NAV_ADMIN: NavItem[] = [
  { path: "/admin/services", label: "サービス管理" },
  { path: "/organizations", label: "組織の管理" },
  { path: "/admin/access", label: "審査" },
  { path: "/account-recovery", label: "回復" },
  { path: "/oidc-clients", label: "OIDC" },
  { path: "/enterprise", label: "Cloudflare" },
  { path: "/onsite-kiosks", label: "Kiosk" },
  { path: "/admin/workloads", label: "拠点認証" },
  { path: "/admin/discord-bot", label: "Discord Bot" },
];

/** server の ORG_MANAGER_ROLES (server/src/org/role-policy.ts) と揃える。 */
export const ORG_MANAGER_ROLES = ["owner", "admin", "maintainer", "leader"];

export function isOrgManagerRole(role: string | undefined): boolean {
  return !!role && ORG_MANAGER_ROLES.includes(role);
}

export interface NavRows { general: NavItem[]; admin: NavItem[] }

/** 見える人に応じたメニュー。管理者は「組織の管理」を管理者段に持つので一般段の「組織」は出さない。 */
export function navRowsFor({ isAdmin, isOrgManager }: { isAdmin: boolean; isOrgManager: boolean }): NavRows {
  if (isAdmin) return { general: NAV_GENERAL, admin: NAV_ADMIN };
  return { general: isOrgManager ? [...NAV_GENERAL, ...NAV_LEADER] : NAV_GENERAL, admin: [] };
}
