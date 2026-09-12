/**
 * 顔認証 (同意 / 失効指示) API の認可ヘルパーと scope 定義。
 *
 * 本人経路と service 経路で要求する資格情報が違うため、判定をここ 1 箇所に集める。
 * 本人経路は **user_access token のみ**を受け、service 系 claim が混ざった token は
 * 拒否する (同じ HS256 鍵を共有しているため、署名検証だけでは区別できない)。
 */

import { z } from "zod";
import { extractBearerToken, verifyToken } from "../auth/jwt.js";
import { AppError } from "../error.js";

/** 失効指示の pull (Ostiarius)。 */
export const FACE_REVOCATION_READ_SCOPE = "face-revocation:read";
/** 同意記録の pull (Ostiarius)。 */
export const FACE_CONSENT_READ_SCOPE = "face-consent:read";
/** kiosk 上の撤回を Cernere へ書き戻す経路。read と分けて最小権限にする。 */
export const FACE_CONSENT_REVOKE_SCOPE = "face-consent:revoke";

const uuidSchema = z.string().uuid();

export async function currentUser(authHeader: string): Promise<string> {
  const token = extractBearerToken(authHeader);
  if (!token) throw AppError.unauthorized("Missing bearer token");
  const claims = await verifyToken(token) as Awaited<ReturnType<typeof verifyToken>> & {
    owner?: unknown;
    tokenType?: unknown;
  };
  if (typeof claims.sub !== "string"
    || typeof claims.role !== "string"
    || claims.owner !== undefined
    || claims.tokenType !== "user_access"
    || !uuidSchema.safeParse(claims.sub).success) {
    throw AppError.unauthorized("Invalid user access token");
  }
  return claims.sub;
}
