/**
 * WebAuthn Signal API (対応ブラウザだけ。非対応では何もしない)。
 *
 * 名前を後から入れたとき、認証器のアカウント一覧に出ている暫定名 (`Cernere xxxxxxxx`) を
 * 本当の名前に更新する。本人確認や二重アカウント防止の仕組みではない。
 */

interface SignalCapablePublicKeyCredential {
  signalCurrentUserDetails?: (details: { rpId: string; userId: string; name: string; displayName: string }) => Promise<void>;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** user handle は users.id の UTF-8 バイト列 (サーバーの登録時と同じ)。 */
export async function signalCurrentUserName(userId: string, name: string): Promise<void> {
  const api = (globalThis.PublicKeyCredential as unknown as SignalCapablePublicKeyCredential | undefined);
  if (!api?.signalCurrentUserDetails) return;
  try {
    await api.signalCurrentUserDetails({ rpId: window.location.hostname, userId: toBase64Url(userId), name, displayName: name });
  } catch {
    /* 補助的な表示更新なので、失敗しても名前の保存には影響させない */
  }
}
