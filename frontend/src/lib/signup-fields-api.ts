/**
 * サービス経由ログイン時の入力項目 (signup_fields) の API と型。
 *
 * 形はサーバの signup-fields/requirement.ts (SignupFieldView) と同じ。
 * /consent は consent-api の ticket 判断に、プロフィールの「サービスの権限」は consent.decide に値を載せる。
 * オンボーディングは WS module "signup_fields" (for_return / save) を使う。
 * spec/plan/2026-10-15-service-signup-fields-design.md
 */

import { wsClient } from "./ws-client";

export type SignupFieldInput = "text" | "textarea" | "select" | "boolean" | "number";
export type SignupFieldVisibility = "self" | "service_users" | "public";
export type SignupFieldValue = string | number | boolean | null;

export interface SignupFieldView {
  /** 保存先 project (共有を受けている列)。このサービス自身の列は null */
  project: string | null;
  column: string;
  label: string;
  required: boolean;
  input: SignupFieldInput;
  columnType: string;
  maxLength: number | null;
  placeholder: string | null;
  help: string | null;
  options: Array<{ value: string; label: string }> | null;
  /** その列の module の consent 宣言の visible_to。null = このサービス */
  visibleTo: SignupFieldVisibility[] | null;
  /** 共有を受けている列の、このサービス以外の共有先 (サービス名)。このサービス自身の列は null */
  sharedWith: string[] | null;
  value: SignupFieldValue;
  filled: boolean;
}

export interface SignupFieldsDescription {
  version: number;
  fields: SignupFieldView[];
}

/** 項目ごとの誤り (列名 → 文言)。 */
export type SignupFieldErrors = Record<string, string>;

export interface SignupFieldsForService extends SignupFieldsDescription {
  projectKey: string;
  serviceName: string;
  missingRequired: string[];
}

export type SignupFieldsSaveResult =
  | ({ ok: true } & SignupFieldsForService)
  | { ok: false; fieldErrors: SignupFieldErrors };

export const signupFieldsApi = {
  /** オンボーディングの戻り先からログイン先サービスの入力項目を引く。対象が無ければ null。 */
  forReturn(returnTo: string): Promise<SignupFieldsForService | null> {
    return wsClient.sendCommand<SignupFieldsForService | null>("signup_fields", "for_return", { returnTo });
  },
  save(projectKey: string, fields: Record<string, SignupFieldValue>): Promise<SignupFieldsSaveResult> {
    return wsClient.sendCommand<SignupFieldsSaveResult>("signup_fields", "save", { projectKey, fields });
  },
};

/** フォームの初期値 (現在の値。未入力は空)。 */
export function initialSignupValues(fields: readonly SignupFieldView[]): Record<string, SignupFieldValue> {
  return Object.fromEntries(fields.map((f) => [f.column, f.value]));
}

/** 必須が全て入っているか (送信ボタンの有効化。最終判定はサーバ)。 */
export function requiredFilled(fields: readonly SignupFieldView[], values: Record<string, SignupFieldValue>): boolean {
  return fields.every((f) => {
    if (!f.required) return true;
    const value = values[f.column];
    return value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
  });
}
