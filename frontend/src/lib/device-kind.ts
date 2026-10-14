/**
 * この端末がスマホ (タブレット含む) か。初回ログイン後に「スマホ用 QR」を出すかの
 * 表示の出し分けにだけ使い、サーバーの認可には使わない (SPEC-FIRST-LOGIN-PHONE-QR)。
 * UA-CH を優先し、無ければ UA 文字列で判定する。iPadOS の desktop UA は PC 扱いになるが、
 * QR が出るだけで害は無い。
 */

interface NavigatorWithUaData extends Navigator {
  userAgentData?: { mobile?: boolean };
}

export function isMobileDevice(nav: NavigatorWithUaData = navigator): boolean {
  if (typeof nav.userAgentData?.mobile === "boolean") return nav.userAgentData.mobile;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent);
}
