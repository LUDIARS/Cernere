/**
 * Device Credential token の形式
 * (spec/plan/passkey-default-authentication.md §7.2)
 *
 * `cdt1.<device_id>.<secret>` の version 付き opaque token。
 * ログ・URL・DB に token 全体を保存しない。
 */

export const DEVICE_TOKEN_PREFIX = "cdt1";

export interface ParsedDeviceToken {
  deviceId: string;
  secret: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * token を device_id と secret に分解する。 形式不正は null。
 *
 * secret に `.` が含まれても壊れないよう、 先頭 2 つの区切りだけで分割する。
 */
export function parseDeviceToken(token: string | null | undefined): ParsedDeviceToken | null {
  if (!token) return null;
  const firstDot = token.indexOf(".");
  if (firstDot < 0) return null;
  if (token.slice(0, firstDot) !== DEVICE_TOKEN_PREFIX) return null;
  const secondDot = token.indexOf(".", firstDot + 1);
  if (secondDot < 0) return null;
  const deviceId = token.slice(firstDot + 1, secondDot);
  const secret = token.slice(secondDot + 1);
  if (!UUID_RE.test(deviceId) || !secret) return null;
  return { deviceId, secret };
}

/** device_id と secret から token を組み立てる。 */
export function formatDeviceToken(deviceId: string, secret: string): string {
  return `${DEVICE_TOKEN_PREFIX}.${deviceId}.${secret}`;
}
