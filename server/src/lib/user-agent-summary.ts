/**
 * User-Agent を「ブラウザ / OS」の概略に縮める。
 *
 * 端末追加の承認画面とログイン通知に出す参考情報で、本人確認や認可には使わない
 * (UA は送信者が自由に偽れる)。表示前に呼び出し側でエスケープすること。
 */

const OS_RULES: ReadonlyArray<[RegExp, string]> = [
  [/iPhone|iPod/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows NT/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];

// 順序が意味を持つ (Edge / Opera の UA は Chrome を、Chrome の UA は Safari を含む)。
const BROWSER_RULES: ReadonlyArray<[RegExp, string]> = [
  [/Edg\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const MAX_LENGTH = 64;

export function summarizeUserAgent(userAgent: string | undefined | null): string {
  if (!userAgent) return "Unknown device";
  const os = OS_RULES.find(([re]) => re.test(userAgent))?.[1];
  const browser = BROWSER_RULES.find(([re]) => re.test(userAgent))?.[1];
  const summary = [browser, os].filter(Boolean).join(" / ");
  return (summary || "Unknown device").slice(0, MAX_LENGTH);
}
