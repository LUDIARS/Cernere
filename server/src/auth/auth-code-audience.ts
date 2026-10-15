/**
 * authCode の用途 (audience) と交換元の突き合わせ (許可制 案 A)。
 *
 * Cernere 自身の /login 用 (audience = "cernere") の authCode は、許可待ちでも発行される代わりに
 * Cernere の画面の origin からしか交換できない。それ以外 (サービスのバックエンド等) から交換されたときは
 * 「許可待ち」ではなく「用途が違う」ことを返す。以前は approval_required を返しており、
 * サービス側が「許可待ち」と誤表示したり、FRONTEND_URL の設定誤り (Cernere の画面の origin が
 * 合わない) が許可の問題に見えたりした (2026-10-15)。
 */

export const AUTH_CODE_AUDIENCE_MISMATCH = "auth_code_audience_mismatch";

export interface AudienceMismatch {
  code: typeof AUTH_CODE_AUDIENCE_MISMATCH;
  message: string;
}

/** 交換を拒否すべきなら理由を、受け付けてよいなら null を返す。 */
export function checkExchangeAudience(audience: unknown, fromCernereFrontend: boolean): AudienceMismatch | null {
  if (audience !== "cernere" || fromCernereFrontend) return null;
  return {
    code: AUTH_CODE_AUDIENCE_MISMATCH,
    message: "This sign-in code was issued for Cernere's own login page and can only be exchanged from it "
      + "(check that the request Origin matches FRONTEND_URL)",
  };
}
