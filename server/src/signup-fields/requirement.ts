/**
 * 入力項目の要否と画面の表示データを決める純粋関数 (設計書 §3)。
 *
 *   (宣言, 列定義, 現在の行の値, 拒否された module, 見せた記録) → { missingRequired, optionalUnfilled, fields }
 *
 * - 入力済みの列は聞かない
 * - 同意で拒否された module の列は聞かない (必須でも。宣言の検証で推奨 module の列は必須にならない)
 * - 任意は、同じ版で一度見せたら空のままでも再表示しない。版が上がったら、まだ見せていない列だけ出す
 */

import type { ConsentDeclaration, DeclaredVisibility } from "../consent/declaration-schema.js";
import { activeColumn, type SignupColumns } from "./declaration.js";
import { textLimitOf, type SignupField, type SignupFieldsDeclaration } from "./declaration-schema.js";
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:066843ab */
import augurContract_66b85569 from './contracts/requirement.contract.js'; /* augur-inject:contract-predicate:5a255e6b */

/** 前回の画面で見せた版と列 (user_service_consents.fields_version / fields_seen)。 */
export interface SignupFieldsSeen {
  version: number | null;
  columns: readonly string[];
}

export interface SignupFieldsInput {
  declaration: SignupFieldsDeclaration | null;
  columns: SignupColumns;
  /** 本人の行の現在の値。行が無ければ {} */
  values: Readonly<Record<string, unknown>>;
  /** 同意で拒否された (= 値を渡さない) user_data の module */
  deniedModules: ReadonlySet<string>;
  seen: SignupFieldsSeen;
  /** 「誰が読めるか」を引くための同意宣言 */
  consent: ConsentDeclaration | null;
}

export interface SignupFieldView {
  column: string;
  label: string;
  required: boolean;
  input: SignupField["input"];
  /** 列の型 (number の範囲の検査に使う) */
  columnType: string;
  /** text / textarea の上限 */
  maxLength: number | null;
  placeholder: string | null;
  help: string | null;
  options: Array<{ value: string; label: string }> | null;
  /** その列の module の consent 宣言の visible_to。宣言が無ければ null (= このサービス) */
  visibleTo: DeclaredVisibility[] | null;
  /** 現在の値 (未入力は null) */
  value: string | number | boolean | null;
  filled: boolean;
}

export interface SignupFieldsRequirement {
  declared: boolean;
  version: number;
  /** 未入力の必須 (1 つでもあれば authCode を出さない) */
  missingRequired: string[];
  /** まだ見せていない未入力の任意 (ログインは止めない。画面を出すときに一緒に聞く) */
  optionalUnfilled: string[];
  /** 画面で聞く項目 (missingRequired ∪ optionalUnfilled、宣言の順) */
  fields: SignupFieldView[];
  /** 聞ける全項目 (拒否 module を除く。プロフィールの見直し用) */
  all: SignupFieldView[];
}

const EMPTY: SignupFieldsRequirement = {
  declared: false, version: 0, missingRequired: [], optionalUnfilled: [], fields: [], all: [],
};

export function isFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

function displayValue(value: unknown): SignupFieldView["value"] {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  // bigint 列は postgres.js が文字列で返す。数値に収まらなければ文字列のまま見せる。
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  return null;
}

function visibilityOf(consent: ConsentDeclaration | null, module: string | undefined): DeclaredVisibility[] | null {
  if (!module) return null;
  const permission = consent?.permissions.find((p) => p.key === `user_data.module:${module}`);
  return permission ? [...permission.visible_to] : null;
}

/** 契約 C-28 (server/src/signup-fields/contracts/requirement.contract.ts) は augur inject が包む。 */
export function evaluateSignupFields(input: SignupFieldsInput): SignupFieldsRequirement {
  const { declaration } = input;
  if (!declaration) return EMPTY;

  const all: SignupFieldView[] = [];
  for (const field of declaration.fields) {
    const column = activeColumn(input.columns, field.column);
    // 宣言後に列が消された / module を拒否された列は聞かない。
    if (!column || (column.module && input.deniedModules.has(column.module))) continue;
    const raw = input.values[field.column];
    all.push({
      column: field.column,
      label: field.label,
      required: field.required,
      input: field.input,
      columnType: column.type,
      maxLength: field.input === "text" || field.input === "textarea" ? textLimitOf(field) : null,
      placeholder: field.placeholder ?? null,
      help: field.help ?? null,
      options: field.options ? field.options.map((o) => ({ value: o.value, label: o.label })) : null,
      visibleTo: visibilityOf(input.consent, column.module),
      value: isFilled(raw) ? displayValue(raw) : null,
      filled: isFilled(raw),
    });
  }

  const { seen } = input;
  const shownBefore = (column: string) => seen.version !== null
    && (seen.version >= declaration.version || seen.columns.includes(column));
  const missingRequired = all.filter((f) => f.required && !f.filled).map((f) => f.column);
  const optionalUnfilled = all.filter((f) => !f.required && !f.filled && !shownBefore(f.column)).map((f) => f.column);
  const asked = new Set([...missingRequired, ...optionalUnfilled]);

  return {
    declared: true,
    version: declaration.version,
    missingRequired,
    optionalUnfilled,
    fields: all.filter((f) => asked.has(f.column)),
    all,
  };
}
// @ts-expect-error augur-inject
evaluateSignupFields = contract(evaluateSignupFields, { ...augurContract_66b85569, contractId: 'C-28', mode: 'observe', sample: 1, where: 'server/src/signup-fields/requirement.ts:89', rule: 'contract-wrap', id: '66b85569' }); /* augur-inject:contract-wrap:66b85569 */
