/**
 * ゲスト WS セッション用 auth コマンド処理
 */

import { retiredLoginError } from "../auth/retired-login.js";
import { AppError } from "../error.js";
import { sendMfaChallengeCode, verifyMfaChallenge, issueMfaLogin } from "../auth/mfa-challenge.js";
import { parseMfaInput, requireMfaMethod } from "../auth/mfa-contract.js";

export interface GuestAuthResult {
  userId?: string;
  accessToken?: string;
  refreshToken?: string;
  user?: unknown;
  mfaRequired?: boolean;
  mfaMethods?: string[];
  mfaToken?: string;
}

export async function handleGuestAuthCommand(
  action: string,
  payload: unknown,
  ip?: string,
): Promise<GuestAuthResult> {
  const p = payload as Record<string, unknown> | undefined;
  if (!p) throw AppError.badRequest("Payload required");

  switch (action) {
    // メール+パスワードの登録・ログインは廃止 (パスキーのみ)。
    case "register": case "login": throw retiredLoginError();
    case "mfa-verify": {
      const input = parseMfaInput(p);
      return verifyMfaChallenge(input.mfaToken ?? "", requireMfaMethod(input.method), input.code ?? "", { purpose: "guest" }, issueMfaLogin);
    }
    case "mfa-send-code": {
      const input = parseMfaInput(p);
      await sendMfaChallengeCode(input.mfaToken ?? "", requireMfaMethod(input.method), { purpose: "guest" });
      return {};
    }
    default:
      throw AppError.badRequest(`Guest auth action '${action}' not supported. Use 'register' or 'login'.`);
  }
}
