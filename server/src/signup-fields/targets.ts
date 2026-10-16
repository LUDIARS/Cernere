/**
 * 入力項目の保存先表の振り分け (設計書 §8.2)。純粋関数だけを持つ。
 *
 * 自分の列は project_data_<自分の storage_slug>、共有を受けている列は共有元の表へ。
 * 列名は宣言全体で一意 (declaration.ts) なので、値は列名で引ける。
 */

import { activeColumn, type SignupColumns } from "./declaration.js";
import type { SignupFieldsDeclaration } from "./declaration-schema.js";
import type { SignupFieldView } from "./requirement.js";
import { fieldSourceProject } from "./shared-source.js";
import type { SignupValue } from "./values.js";

export interface SignupTableSource {
  projectKey: string;
  storageTable: string;
  columns: SignupColumns;
}

export interface SignupTableGroup<V> {
  projectKey: string;
  table: string;
  values: Record<string, V>;
}

/** 宣言の列を保存先表ごとに分ける (読み込み用)。いま有効でない列・grant の外れた列は載せない。 */
export function readableColumnsByTable(
  declaration: SignupFieldsDeclaration,
  own: SignupTableSource,
  sources: Readonly<Record<string, SignupTableSource>>,
): Array<{ projectKey: string; table: string; columns: string[] }> {
  const groups = new Map<string, { projectKey: string; table: string; columns: string[] }>();
  for (const field of declaration.fields) {
    const project = fieldSourceProject(field, own.projectKey);
    const source = project === null ? own : Object.prototype.hasOwnProperty.call(sources, project) ? sources[project] : null;
    if (!source || !activeColumn(source.columns, field.column)) continue;
    const group = groups.get(source.storageTable) ?? { projectKey: source.projectKey, table: source.storageTable, columns: [] };
    group.columns.push(field.column);
    groups.set(source.storageTable, group);
  }
  return [...groups.values()];
}

/**
 * 検証済みの値を保存先表ごとに分ける (書き込み用)。自分の表は値が無くても先頭に置く (行を作る、従来どおり)。
 * 共有元の表は値があるときだけ。views に無い列 (聞いていない列) は書かない。
 */
export function valuesByTable(
  values: Readonly<Record<string, SignupValue>>,
  views: readonly SignupFieldView[],
  own: { projectKey: string; storageTable: string },
  sources: Readonly<Record<string, { storageTable: string }>>,
): Array<SignupTableGroup<SignupValue>> {
  const ownGroup: SignupTableGroup<SignupValue> = { projectKey: own.projectKey, table: own.storageTable, values: {} };
  const shared = new Map<string, SignupTableGroup<SignupValue>>();
  for (const view of views) {
    if (!Object.prototype.hasOwnProperty.call(values, view.column)) continue;
    if (view.project === null) {
      ownGroup.values[view.column] = values[view.column];
      continue;
    }
    const source = Object.prototype.hasOwnProperty.call(sources, view.project) ? sources[view.project] : null;
    if (!source) continue;
    const group = shared.get(view.project) ?? { projectKey: view.project, table: source.storageTable, values: {} };
    group.values[view.column] = values[view.column];
    shared.set(view.project, group);
  }
  return [ownGroup, ...shared.values()];
}
