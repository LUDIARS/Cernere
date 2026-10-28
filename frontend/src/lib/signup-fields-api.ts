/**
 * サービス経由ログイン時の入力項目 (signup_fields) の API と型。
 *
 * 形はサーバの signup-fields/requirement.ts (SignupFieldView) と同じ。
 * /consent は consent-api の ticket 判断に、プロフィールの「サービスの権限」は consent.decide に値を載せる。
 * オンボーディングは WS module "signup_fields" (for_return / save) を使う。
 * spec/plan/2026-10-15-service-signup-fields-design.md
 */

import { wsClient } from "./ws-client";
import type { SignupFieldFormView, SignupFieldValue } from "./signup-fields-form";

export { initialSignupValues, isSignupFieldVisible, requiredFilled } from "./signup-fields-form";
export type { SignupFieldValue } from "./signup-fields-form";

export type SignupFieldInput = "text" | "textarea" | "select" | "tabs" | "boolean" | "number";
export type SignupFieldVisibility = "self" | "service_users" | "public";

export interface SignupFieldView extends SignupFieldFormView {
  /** 保存先 project (共有を受けている列)。このサービス自身の列は null */
  project: string | null;
  column: string;
  label: string;
  required: boolean;
  visibleWhen?: { column: string; value: string };
  minimum?: number;
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

