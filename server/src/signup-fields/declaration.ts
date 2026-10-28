/**
 * 入力項目の宣言の検証 — 形・列定義との突き合わせ・consent との整合・版の単調増加 (設計書 §2)。
 *
 * サービス (project client) は update_schema で `signup_fields` を宣言できる。聞けるのは
 * `user_data.columns` にある有効な列だけで、列の型と入力の種類が合わなければ保存しない。
 */

import type { ConsentDeclaration } from "../consent/declaration-schema.js";
import { signupFieldsDeclarationSchema, type SignupFieldInput, type SignupFieldsDeclaration } from "./declaration-schema.js";
import { fieldSourceProject, writableSharedColumns, type SharedProjectDefinition } from "./shared-source.js";
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:589c5618 */
import augurContract_f5dc0751 from './contracts/declaration.contract.js'; /* augur-inject:contract-predicate:cb670dc8 */

/** user_data.columns の 1 列 (検証に要る部分)。 */
export interface SignupColumn {
  type: string;
  module?: string;
  _deleted?: boolean;
}

export type SignupColumns = Readonly<Record<string, SignupColumn>>;

/**
 * 共有を受けている列の検証材料 (設計書 §8)。ownKey は宣言する project、sources は宣言が参照する
 * 共有元 project の定義 (存在しない・無効な project は null)。
 */
export interface SignupSharing {
  ownKey: string;
  sources: Readonly<Record<string, SharedProjectDefinition | null>>;
}

export type SignupFieldsCheck =
  | { ok: true; declaration: SignupFieldsDeclaration }
  | { ok: false; errors: string[] };

/** 入力の種類ごとに受け付ける列の型。 */
const COLUMN_TYPES_BY_INPUT: Record<SignupFieldInput, readonly string[]> = {
  text: ["text"],
  textarea: ["text"],
  select: ["text"],
  tabs: ["text"],
  boolean: ["boolean"],
  number: ["integer", "bigint"],
};

/** 有効な (存在し論理削除されていない) 列。 */
export function activeColumn(columns: SignupColumns, name: string): SignupColumn | null {
  const column = Object.prototype.hasOwnProperty.call(columns, name) ? columns[name] : undefined;
  return column && !column._deleted ? column : null;
}

/** consent で `level: recommended` と宣言された user_data の module。 */
function recommendedModules(consent: ConsentDeclaration | null): Set<string> {
  const modules = new Set<string>();
  for (const permission of consent?.permissions ?? []) {
    if (permission.level === "recommended" && permission.key.startsWith("user_data.module:")) {
      modules.add(permission.key.slice("user_data.module:".length));
    }
  }
  return modules;
}

/** 共有元 project の列。readwrite grant の範囲外・存在しない列は理由を report して null。 */
function sharedColumn(
  name: string,
  project: string,
  sharing: SignupSharing | undefined,
  report: (message: string) => void,
): SignupColumn | null {
  const definition = sharing && Object.prototype.hasOwnProperty.call(sharing.sources, project) ? sharing.sources[project] : null;
  if (!sharing || !definition) {
    report(`project: ${project} is not an active project`);
    return null;
  }
  if (!activeColumn(definition.columns, name)) {
    report(`column: ${name} is not an active user_data column of ${project}`);
    return null;
  }
  const writable = writableSharedColumns(definition, sharing.ownKey);
  if (!writable) {
    report(`project: ${project} has no readwrite data_sharing grant for ${sharing.ownKey}`);
    return null;
  }
  const column = activeColumn(writable, name);
  if (!column) report(`column: ${name} of ${project} is outside the data_sharing grant for ${sharing.ownKey}`);
  return column;
}

/** Resolve the writable column used by a declaration field without adding duplicate diagnostics. */
function declarationColumn(
  field: SignupFieldsDeclaration["fields"][number],
  columns: SignupColumns,
  sharing: SignupSharing | undefined,
): SignupColumn | null {
  const source = fieldSourceProject(field, sharing?.ownKey ?? null);
  return source === null
    ? activeColumn(columns, field.column)
    : sharedColumn(field.column, source, sharing, () => undefined);
}

/**
 * 宣言を検証する。`previousVersion` は保存済みの宣言の版 (無ければ null)。版を下げる更新は拒否する
 * (fields_version で「この版は見せた」を記録しているため、下げると聞き直しが起きなくなる)。
 * `project` を書いた field は sharing の共有元で、readwrite grant の範囲内にある有効な列だけを受け付ける。
 * 契約 C-27 (server/src/signup-fields/contracts/declaration.contract.ts) は augur inject が包む。
 */
export function validateSignupFieldsDeclaration(
  raw: unknown,
  columns: SignupColumns,
  consent: ConsentDeclaration | null,
  previousVersion: number | null,
  sharing?: SignupSharing,
): SignupFieldsCheck {
  const parsed = signupFieldsDeclarationSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `signup_fields.${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const declaration = parsed.data;
  const recommended = recommendedModules(consent);
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [index, field] of declaration.fields.entries()) {
    const where = `signup_fields.fields.${index}`;
    if (field.visible_when) {
      const selector = declaration.fields.find((candidate) => candidate.column === field.visible_when?.column);
      const selectorColumn = selector ? declarationColumn(selector, columns, sharing) : null;
      const fieldColumn = declarationColumn(field, columns, sharing);
      if (!selector || selector === field || selector.visible_when || !selector.required
        || !["tabs", "select"].includes(selector.input)
        || !selector.options?.some((option) => option.value === field.visible_when?.value)
        || fieldSourceProject(selector, sharing?.ownKey ?? null) !== fieldSourceProject(field, sharing?.ownKey ?? null)
        || !selectorColumn || !fieldColumn || selectorColumn.module !== fieldColumn.module) {
        errors.push(`${where}.visible_when: requires an unconditional required selector in the same source and module`);
      }
    }
    if (seen.has(field.column)) errors.push(`${where}.column: duplicate column ${field.column}`);
    seen.add(field.column);
    const source = fieldSourceProject(field, sharing?.ownKey ?? null);
    const column = source === null
      ? activeColumn(columns, field.column)
      : sharedColumn(field.column, source, sharing, (message) => errors.push(`${where}.${message}`));
    if (!column) {
      if (source === null) errors.push(`${where}.column: ${field.column} is not an active user_data column`);
      continue;
    }
    if (!COLUMN_TYPES_BY_INPUT[field.input].includes(column.type)) {
      errors.push(`${where}.input: ${field.input} does not fit column type ${column.type}`);
    }
    // 共有元の module はこのサービスの consent 宣言とは別物 (§8.1)。
    if (source === null && field.required && column.module && recommended.has(column.module)) {
      errors.push(`${where}.required: ${field.column} belongs to recommended module ${column.module} and cannot be required`);
    }
    const values = (field.options ?? []).map((o) => o.value);
    if (new Set(values).size !== values.length) errors.push(`${where}.options: duplicate option value`);
  }
  if (previousVersion !== null && declaration.version < previousVersion) {
    errors.push(`signup_fields.version: must not go down (stored ${previousVersion}, got ${declaration.version})`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, declaration };
}
// @ts-expect-error augur-inject
validateSignupFieldsDeclaration = contract(validateSignupFieldsDeclaration, { ...augurContract_f5dc0751, contractId: 'C-27', mode: 'observe', sample: 1, where: 'server/src/signup-fields/declaration.ts:55', rule: 'contract-wrap', id: 'f5dc0751' }); /* augur-inject:contract-wrap:f5dc0751 */
