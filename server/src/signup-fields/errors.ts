/**
 * 入力項目の誤り (項目ごと)。REST は 422 + fieldErrors、WS は応答 payload の fieldErrors で返す。
 * DB を引き込まない軽いモジュールにしておく (consent-handler / command から instanceof で見分ける)。
 */

import { AppError } from "../error.js";

export const SIGNUP_FIELDS_INVALID = "signup_fields_invalid";

export class SignupFieldsInvalidError extends AppError {
  constructor(readonly fieldErrors: Record<string, string>) {
    super(422, "Some fields are invalid", SIGNUP_FIELDS_INVALID);
    this.name = "SignupFieldsInvalidError";
  }
}

/** 422 応答の本体 (REST)。 */
export function signupFieldsInvalidBody(error: SignupFieldsInvalidError): Record<string, unknown> {
  return { error: error.message, code: SIGNUP_FIELDS_INVALID, fieldErrors: error.fieldErrors };
}
