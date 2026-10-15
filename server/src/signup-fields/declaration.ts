/**
 * 入力項目の宣言の検証 — 形・列定義との突き合わせ・consent との整合・版の単調増加 (設計書 §2)。
 *
 * サービス (project client) は update_schema で `signup_fields` を宣言できる。聞けるのは
 * `user_data.columns` にある有効な列だけで、列の型と入力の種類が合わなければ保存しない。
 */

import type { ConsentDeclaration } from "../consent/declaration-schema.js";
import { signupFieldsDeclarationSchema, type SignupFieldInput, type SignupFieldsDeclaration } from "./declaration-schema.js";
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:589c5618 */
import augurContract_f5dc0751 from './contracts/declaration.contract.js'; /* augur-inject:contract-predicate:cb670dc8 */

/** user_data.columns の 1 列 (検証に要る部分)。 */
export interface SignupColumn {
  type: string;
  module?: string;
  _deleted?: boolean;
}

export type SignupColumns = Readonly<Record<string, SignupColumn>>;

export type SignupFieldsCheck =
  | { ok: true; declaration: SignupFieldsDeclaration }
  | { ok: false; errors: string[] };

/** 入力の種類ごとに受け付ける列の型。 */
const COLUMN_TYPES_BY_INPUT: Record<SignupFieldInput, readonly string[]> = {
  text: ["text"],
  textarea: ["text"],
  select: ["text"],
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

/**
 * 宣言を検証する。`previousVersion` は保存済みの宣言の版 (無ければ null)。版を下げる更新は拒否する
 * (fields_version で「この版は見せた」を記録しているため、下げると聞き直しが起きなくなる)。
 * 契約 C-27 (server/src/signup-fields/contracts/declaration.contract.ts) は augur inject が包む。
 */
export function validateSignupFieldsDeclaration(
  raw: unknown,
  columns: SignupColumns,
  consent: ConsentDeclaration | null,
  previousVersion: number | null,
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
    if (seen.has(field.column)) errors.push(`${where}.column: duplicate column ${field.column}`);
    seen.add(field.column);
    const column = activeColumn(columns, field.column);
    if (!column) {
      errors.push(`${where}.column: ${field.column} is not an active user_data column`);
      continue;
    }
    if (!COLUMN_TYPES_BY_INPUT[field.input].includes(column.type)) {
      errors.push(`${where}.input: ${field.input} does not fit column type ${column.type}`);
    }
    if (field.required && column.module && recommended.has(column.module)) {
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
