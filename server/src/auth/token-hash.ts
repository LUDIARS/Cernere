import { createHash } from "node:crypto";

/**
 * refresh_token の DB 保存用ハッシュ。
 * トークン自体が暗号論的乱数 (JWT / UUID ベース) のため HMAC salt は不要。
 * DB 漏洩時に平文トークンが直接露出しないことを目的とする。
 */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
