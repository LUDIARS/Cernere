/**
 * Cernere 単独フロントのログイン画面。
 *
 * 認証 UI / 処理は composite (CompositeLoginPage) に一本化されており、
 * ここでは self モードで描画するだけ。 self モードは authCode を
 * /api/auth/exchange で自分のトークンに交換してアプリへ入る。
 *
 * Query params:
 *   mode=register - 新規登録タブを初期表示 (未指定時は初訪問なら Register 優先)
 *   redirect=/x   - ログイン完了後の戻り先 (ローカルパスのみ)
 */

import { CompositeLoginPage } from "./composite/CompositeLoginPage";

export function LoginPage() {
  return <CompositeLoginPage self />;
}
