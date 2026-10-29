/**
 * 未登録 (または有効な passkey が無い) アカウントへのログイン開始に返す偽の credential。
 *
 * email 指定の login-begin は allowCredentials を返す。 未登録のときだけ空にすると、
 * 誰でもメールアドレスの登録有無を確かめられる。 同じ email には毎回同じ偽 ID を返し
 * (秘密鍵付き HMAC なので第三者は本物と区別できない)、 登録済みと同じ形の応答にする。
 */
import crypto from "node:crypto";

export interface DecoyCredential {
  id: string;
  transports: ("internal" | "hybrid")[];
}

export function passkeyLoginDecoy(email: string, secret: string): DecoyCredential[] {
  const id = crypto.createHmac("sha256", secret)
    .update(`passkey-login-decoy:${email.trim().toLowerCase()}`)
    .digest("base64url");
  return [{ id, transports: ["internal", "hybrid"] }];
}
