/**
 * 廃止したログイン方式の応答 (spec/plan/2026-10-14-passkey-only-authentication.md §1)。
 *
 * 利用者のログイン・新規登録はパスキーだけになった。メール+パスワード / GitHub / Google の
 * 入口は 410 を返し、旧クライアントが黙って失敗しないよう理由を明示する。
 * DB の password_hash / github_id / google_id は消さない (連携とデータ保全のため)。
 */

import { AppError } from "../error.js";

export type RetiredLoginMethod = "password" | "github" | "google";

export const LOGIN_METHOD_RETIRED_ERROR = "login_method_retired";

export const LOGIN_METHOD_RETIRED_MESSAGE =
  "This sign-in method has been retired. Sign in with a passkey.";

export interface RetiredLoginBody {
  error: typeof LOGIN_METHOD_RETIRED_ERROR;
  method: RetiredLoginMethod;
  message: string;
}

export function retiredLoginBody(method: RetiredLoginMethod): RetiredLoginBody {
  return { error: LOGIN_METHOD_RETIRED_ERROR, method, message: LOGIN_METHOD_RETIRED_MESSAGE };
}

export function retiredLoginResult(method: RetiredLoginMethod): { status: string; data: RetiredLoginBody } {
  return { status: "410 Gone", data: retiredLoginBody(method) };
}

/** throw で返す経路 (project WS・ゲスト WS) 用。HTTP 層は 410 と同じ本文に変換する。 */
export function retiredLoginError(method: RetiredLoginMethod = "password"): AppError {
  return AppError.withCode(410, LOGIN_METHOD_RETIRED_ERROR, `${LOGIN_METHOD_RETIRED_MESSAGE} (${method})`);
}
