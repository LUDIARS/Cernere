/**
 * `/api/auth/me` の応答を画面のログイン中ユーザーに写す。
 *
 * サーバーは表示名を `name` で返す (server/src/http/auth-handler.ts の me)。
 * 以前は `displayName` を読んでいたため、名前を保存しても空として扱われ、
 * RequireAuth がオンボーディングの名前入力へ戻し続けていた。
 */

export interface MeResponse {
  id: string;
  name?: string | null;
  displayName?: string | null;
  email: string | null;
  role: string;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

export function toAuthUser(me: MeResponse): AuthUser {
  const name = (me.name ?? me.displayName ?? "").trim();
  return { id: me.id, name, email: me.email || "", role: me.role };
}
