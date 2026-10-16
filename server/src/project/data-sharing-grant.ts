/**
 * data_sharing の grant 判定 (純粋関数)。
 *
 * data-sharing.ts (他 project の行の読み書き) と signup-fields (共有を受けている列を入力項目にする、
 * spec/plan/2026-10-15-service-signup-fields-design.md §8) が同じ規則で列の範囲を決めるために分けている。
 * DB も service.ts も引き込まない (signup-fields/declaration.ts から import されるため)。
 */

export interface ShareGrant {
  project_key: string;
  modules?: readonly string[];
  columns?: readonly string[];
  access?: "read" | "readwrite";
}

export type ShareColumns = Readonly<Record<string, { type: string; module?: string; _deleted?: boolean }>>;

type Access = "read" | "readwrite";

/**
 * callerProjectKey への grant のうち access が accepted に含まれるもの。無ければ null。
 * access の無い (DB に直接書かれた) grant はどれにも当たらない (fail closed、data-sharing.ts と同じ)。
 */
export function findShareGrant(
  dataSharing: readonly ShareGrant[] | undefined,
  callerProjectKey: string,
  accepted: readonly Access[],
): ShareGrant | null {
  return (dataSharing ?? []).find((share) =>
    share.project_key === callerProjectKey && share.access !== undefined && accepted.includes(share.access)) ?? null;
}

/** 列が grant の範囲内にあるか (存在し論理削除されておらず、modules / columns の指定に入る)。 */
export function isColumnAllowedByGrant(columnName: string, columns: ShareColumns, entry: ShareGrant): boolean {
  const column = Object.prototype.hasOwnProperty.call(columns, columnName) ? columns[columnName] : undefined;
  if (!column || column._deleted) return false;

  if (entry.modules && entry.modules.length > 0) {
    if (!column.module || !entry.modules.includes(column.module)) return false;
  }

  // columns 未指定は既存定義との互換モード。明示した空配列は deny-all として扱う。
  return entry.columns === undefined || entry.columns.includes(columnName);
}

/** その列を読める (read / readwrite の grant を持つ) project key の一覧 (data_sharing の順)。 */
export function projectsSharingColumn(
  dataSharing: readonly ShareGrant[] | undefined,
  columns: ShareColumns,
  columnName: string,
): string[] {
  return (dataSharing ?? [])
    .filter((share) => isColumnAllowedByGrant(columnName, columns, share))
    .map((share) => share.project_key);
}
