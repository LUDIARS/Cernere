/**
 * オンボーディング後の戻り先。開いたページから渡され、Cernere 内のパスだけを受け付ける
 * (外部 URL へ飛ばす open redirect にしない)。
 */

const RETURN_PARAM = "return";

export function safeReturnPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

export function onboardingUrl(returnTo: string): string {
  const params = new URLSearchParams({ [RETURN_PARAM]: safeReturnPath(returnTo) });
  return `/onboarding?${params.toString()}`;
}

/** アカウント作成前の入口 (名前 →「はじめる」でパスキー作成とアカウント作成)。 */
export function startUrl(returnTo: string): string {
  const params = new URLSearchParams({ [RETURN_PARAM]: safeReturnPath(returnTo) });
  return `/start?${params.toString()}`;
}

export function readReturnPath(search: string): string {
  return safeReturnPath(new URLSearchParams(search).get(RETURN_PARAM));
}
