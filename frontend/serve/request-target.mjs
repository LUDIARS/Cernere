// 受け付ける要求行の検査。origin-form (`/path?query`) だけを通し、正規化したパスを返す。
//
// - absolute-form (`http://other/...`) や `*` は中継先を書き換えられるので拒否する。
// - `..` / `.` を含むパスは正規化後と一致しないので拒否する (ゆるく直して通さない)。
// - 制御文字・バックスラッシュ・エンコードした区切り (`%2f` `%5c`) や NUL (`%00`) も拒否する。
const FORBIDDEN = /[\x00-\x20\x7f\\]|%(?:2f|5c|00)/i;

export function parseRequestTarget(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/") || rawUrl.startsWith("//")) return null;
  if (rawUrl.length > 4096 || FORBIDDEN.test(rawUrl)) return null;
  let url;
  try { url = new URL(rawUrl, "http://localhost"); } catch { return null; }
  const rawPath = rawUrl.split(/[?#]/, 1)[0];
  if (url.pathname !== rawPath) return null;
  return { pathname: url.pathname, path: url.pathname + url.search };
}
