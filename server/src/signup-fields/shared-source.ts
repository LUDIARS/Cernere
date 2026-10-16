/**
 * 共有を受けている列 (別 project の user_data) を入力項目にするときの範囲 (設計書 §8)。純粋関数だけを持つ。
 *
 * 書けるのは、共有元の data_sharing にこの project への readwrite grant があり、その grant の範囲内にある
 * 有効な列だけ。判定は data-sharing.ts の読み書きと同じ project/data-sharing-grant.ts を使う。
 */

import { findShareGrant, isColumnAllowedByGrant, projectsSharingColumn, type ShareGrant } from "../project/data-sharing-grant.js";
import type { SignupColumns } from "./declaration.js";
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:1f2ebb12 */
import augurContract_4764251b from './contracts/shared-source.contract.js'; /* augur-inject:contract-predicate:db83dbaa */

/** 共有元 project の定義のうち、判定に要る部分。 */
export interface SharedProjectDefinition {
  columns: SignupColumns;
  dataSharing: readonly ShareGrant[];
}

/** field の保存先 project。自分の列 (project 省略・自分の key) は null。 */
export function fieldSourceProject(field: { project?: string }, ownKey: string | null): string | null {
  return field.project !== undefined && field.project !== ownKey ? field.project : null;
}

/** 契約 C-36 (server/src/signup-fields/contracts/shared-source.contract.ts) は augur inject が包む。 */
export function writableSharedColumns(source: SharedProjectDefinition, callerProjectKey: string): SignupColumns | null {
  const grant = findShareGrant(source.dataSharing, callerProjectKey, ["readwrite"]);
  if (!grant) return null;
  return Object.fromEntries(Object.entries(source.columns)
    .filter(([name]) => isColumnAllowedByGrant(name, source.columns, grant)));
}
// @ts-expect-error augur-inject
writableSharedColumns = contract(writableSharedColumns, { ...augurContract_4764251b, contractId: 'C-36', mode: 'observe', sample: 1, where: 'server/src/signup-fields/shared-source.ts:23', rule: 'contract-wrap', id: '4764251b' }); /* augur-inject:contract-wrap:4764251b */

/** 列を読める project key (callerProjectKey 自身は除く。画面では「このサービス」として別に出す)。 */
export function otherProjectsSharing(source: SharedProjectDefinition, column: string, callerProjectKey: string): string[] {
  return projectsSharingColumn(source.dataSharing, source.columns, column).filter((key) => key !== callerProjectKey);
}
