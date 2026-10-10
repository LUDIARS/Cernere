/**
 * composite 認証の本人確認 WS (`/auth/composite-ws?ticket=...`) の接続先。
 *
 * login / register / mfa-verify は資格情報を確かめた後 `{ ticket, wsPath, wsUrl }` を返す。
 * - wsPath: Cernere と同じ host の画面 (Cernere 自身の /login・/composite/login) が使う相対パス。
 * - wsUrl : サービスの画面 (project WS 経由の埋め込み) が使う絶対 URL。 サービスはこの応答を
 *           そのまま画面へ返し、 埋め込み SDK の <CompositeLogin> がここへ直接つなぐ
 *           (spec/interface/auth-flows.md §5)。 公開 URL は FRONTEND_URL (OAuth の戻り先と同じ。
 *           frontend は /auth を WS ごと backend へ流す)。
 */

export function compositeWsPath(ticket: string): string {
  return `/auth/composite-ws?ticket=${encodeURIComponent(ticket)}`;
}

/** FRONTEND_URL を基点に絶対 URL を作る (http → ws, https → wss)。 解釈できなければ null。 */
export function compositeWsUrl(ticket: string, frontendUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(compositeWsPath(ticket), frontendUrl);
  } catch {
    return null;
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else return null;
  return url.toString();
}
