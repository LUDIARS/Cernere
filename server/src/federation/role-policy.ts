/**
 * 連携したアカウントの有効な role (spec/plan/2026-10-15-account-federation-design.md §3.1)。
 *
 * DB にも Redis にも触れない純粋関数だけを置く。読み出しは effective-role.ts。
 */

/** 有効な role を決めるのに要る、連携の主の状況。連携していなければ null。 */
export interface FederationPrimaryRole {
  primaryUserId: string;
  /** 主の users.role。主の行が無ければ null */
  role: string | null;
  /** 主の users.access_status */
  accessStatus: string | null;
}

/**
 * 有効な role = 連携していれば主の role、していなければ自分の role。
 *   - 自分が主なら自分の role
 *   - 主の行が無い・主が active でない (pending / locked) ときは主の role を引き継がず自分の role
 *     (主を止めたら、連携した他のアカウントの権限も止まるようにする)
 * 自分の users.role 列は書き換えない。連携を外れればこの関数が自分の role を返すので元に戻る。
 */
export function pickEffectiveRole(userId: string, ownRole: string, primary: FederationPrimaryRole | null): string {
  if (!primary || typeof primary.primaryUserId !== "string" || primary.primaryUserId === userId) return ownRole;
  if (typeof primary.role !== "string" || primary.accessStatus !== "active") return ownRole;
  return primary.role;
}
