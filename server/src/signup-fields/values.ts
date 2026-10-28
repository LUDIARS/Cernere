/**
 * 入力値の検証と正規化 (設計書 §4.1)。保存の前に全項目を見て、1 つでも誤りがあれば何も返さない。
 *
 * - 聞いた項目 (fields) 以外の値は捨てる (画面の改ざんで宣言外・拒否 module の列へ書かせない)
 * - 送られなかった項目は書かない。ただし未入力の必須が送られなければ誤り
 * - 空欄は null (任意なら消す、必須なら誤り)
 */

import type { SignupFieldView } from "./requirement.js";
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:2bb1623f */
import augurContract_758cc90b from './contracts/values.contract.js'; /* augur-inject:contract-predicate:136c66d0 */

export type SignupValue = string | number | boolean | null;

export type SignupValuesCheck =
  | { ok: true; values: Record<string, SignupValue> }
  | { ok: false; errors: Record<string, string> };

const INT32_MAX = 2_147_483_647;
const INT32_MIN = -2_147_483_648;

type Normalized = { value: SignupValue } | { error: string };

function normalizeText(field: SignupFieldView, raw: unknown): Normalized {
  if (raw === null) return { value: null };
  if (typeof raw !== "string") return { error: "文字で入力してください" };
  if (field.input === "select" || field.input === "tabs") {
    if (raw.length === 0) return { value: null };
    return field.options?.some((option) => option.value === raw)
      ? { value: raw }
      : { error: "選択肢から選んでください" };
  }
  const text = raw.trim();
  if (text.length === 0) return { value: null };
  if (field.maxLength !== null && text.length > field.maxLength) return { error: `${field.maxLength} 文字以内で入力してください` };
  return { value: text };
}

function normalizeNumber(field: SignupFieldView, raw: unknown): Normalized {
  if (raw === null || (typeof raw === "string" && raw.trim() === "")) return { value: null };
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(n)) return { error: "整数で入力してください" };
  if (field.minimum !== undefined && n < field.minimum) return { error: `${field.minimum} 以上で入力してください` };
  if (field.columnType === "integer" && (n > INT32_MAX || n < INT32_MIN)) return { error: "大きすぎる数です" };
  return { value: n };
}

function normalize(field: SignupFieldView, raw: unknown): Normalized {
  switch (field.input) {
    case "boolean":
      return raw === null || typeof raw === "boolean" ? { value: raw } : { error: "はい / いいえで選んでください" };
    case "number":
      return normalizeNumber(field, raw);
    default:
      return normalizeText(field, raw);
  }
}

/** 契約 C-29 (server/src/signup-fields/contracts/values.contract.ts) は augur inject が包む。 */
export function validateSignupFieldValues(
  fields: readonly SignupFieldView[],
  input: Readonly<Record<string, unknown>>,
): SignupValuesCheck {
  const values: Record<string, SignupValue> = {};
  const errors: Record<string, string> = {};
  const current = Object.fromEntries(fields.map((field) => [field.column, field.value]));
  const effective = { ...current, ...input };
  for (const field of fields) {
    if (field.visibleWhen && effective[field.visibleWhen.column] !== field.visibleWhen.value) continue;
    const provided = Object.prototype.hasOwnProperty.call(input, field.column);
    if (!provided) {
      if (field.required) {
        const stored = normalize(field, field.value);
        if ('error' in stored) errors[field.column] = stored.error;
        else if (stored.value === null) errors[field.column] = "入力してください";
      }
      continue;
    }
    const result = normalize(field, input[field.column]);
    if ("error" in result) errors[field.column] = result.error;
    else if (result.value === null && field.required) errors[field.column] = "入力してください";
    else values[field.column] = result.value;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, values };
}
// @ts-expect-error augur-inject
validateSignupFieldValues = contract(validateSignupFieldValues, { ...augurContract_758cc90b, contractId: 'C-29', mode: 'observe', sample: 1, where: 'server/src/signup-fields/values.ts:54', rule: 'contract-wrap', id: '758cc90b' }); /* augur-inject:contract-wrap:758cc90b */
