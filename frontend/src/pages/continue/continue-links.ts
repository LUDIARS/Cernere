/**
 * 引き継ぎメニューの行き先 (account-federation §4)。どれも Cernere 内のパスだけを作る。
 */

import { safeReturnPath } from "../onboarding/onboarding-return";

/** ログイン画面で「ほかの端末のパスキー」を使う印。adapter が WebAuthn の hints に hybrid を載せる。 */
export const CROSS_DEVICE_PARAM = "cross_device";

/** 引き継ぎメニュー。ログイン後の戻り先と、戻るログイン画面を渡す。 */
export function continueMenuUrl(returnTo: string, loginPath: string): string {
  const params = new URLSearchParams({ return: safeReturnPath(returnTo), login: safeReturnPath(loginPath) });
  return `/continue?${params.toString()}`;
}

/** ① ログイン画面へ戻り、別の端末のパスキーで入る。 */
export function crossDeviceLoginUrl(loginPath: string): string {
  const url = new URL(safeReturnPath(loginPath), window.location.origin);
  url.searchParams.set(CROSS_DEVICE_PARAM, "1");
  return url.pathname + url.search;
}

/** ② この端末を引き継ぐ (新しい端末の画面)。 */
export function federateJoinUrl(returnTo: string): string {
  return `/federate/join?${new URLSearchParams({ return: safeReturnPath(returnTo) }).toString()}`;
}

export function wantsCrossDevice(search: string): boolean {
  return new URLSearchParams(search).get(CROSS_DEVICE_PARAM) === "1";
}
