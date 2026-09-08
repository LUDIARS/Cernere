/**
 * rotating session credential の暗号契約
 * (spec/plan/passkey-default-authentication.md §7.5)
 *
 * master key 1 本から HKDF-SHA256 で用途別の subkey を切る。 用途 (verify / rotate)
 * と方式 (device / email) をドメイン分離し、 1 つの鍵を複数用途で使い回さない。
 *
 * 自由な HMAC / hash 選択や独自暗号化へ分岐しない。 比較は必ず timingSafeEqual。
 *
 * master key rotation では key ID も変え、旧 key を並行検証しない。
 * 通常セッションも止める事故対応では別途全端末失効で auth_epoch を進める。
 * 一次認証 (パスキー) へ戻せるので、 多世代 keyring より全失効の方が単純で安全。
 */

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

const HKDF_SALT = "cernere/session/v1";
const MASTER_KEY_BYTES = 32;
const SUBKEY_BYTES = 32;

/** subkey の用途。 info 文字列がそのままドメイン分離子になる。 */
export type SessionKeyPurpose =
  | "device/verify"
  | "device/rotate"
  | "email/verify"
  | "email/rotate";

export interface SessionKeyMaterial {
  /** DB の token_key_id に保存する識別子。 */
  keyId: string;
  master: Buffer;
}

/**
 * env から master key と key id を読む。
 *
 * 欠損・長さ不正は fail-fast する。 「無ければ生成」 のような無言降格は行わない
 * (RULE §7.1)。 生成に降格すると、 再起動のたびに全端末の Device Credential が
 * 黙って無効になり、 原因の分からないログアウトとして現れる。
 */
export function loadSessionKeyMaterial(env: NodeJS.ProcessEnv = process.env): SessionKeyMaterial {
  const rawKey = env.CERNERE_AUTH_SESSION_KEY;
  if (!rawKey) {
    throw new Error(
      "CERNERE_AUTH_SESSION_KEY must be set (no fallback). Provide it via Infisical/Excubitor inject.",
    );
  }
  const keyId = env.CERNERE_AUTH_SESSION_KEY_ID;
  if (!keyId) {
    throw new Error("CERNERE_AUTH_SESSION_KEY_ID must be set (no default).");
  }
  const master = Buffer.from(rawKey, "base64url");
  if (master.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `CERNERE_AUTH_SESSION_KEY must decode to ${MASTER_KEY_BYTES} bytes (got ${master.length}).`,
    );
  }
  return { keyId, master };
}

/** master key から用途別 subkey を導出する。 */
export function deriveSubkey(master: Buffer, purpose: SessionKeyPurpose): Buffer {
  return Buffer.from(hkdfSync("sha256", master, HKDF_SALT, purpose, SUBKEY_BYTES));
}

/**
 * 検証用ハッシュ。
 *
 * `HMAC-SHA256(K_verify, prefix || id || secret)` を hex で返す。 prefix は token の
 * version 識別子 ("cdt1" / "est1") で、 device と email の値が偶然一致しないようにする。
 */
export function computeSecretHash(
  verifyKey: Buffer,
  prefix: string,
  id: string,
  secret: string,
): string {
  return createHmac("sha256", verifyKey).update(`${prefix}${id}${secret}`).digest("hex");
}

/**
 * 次世代 secret の導出。
 *
 * `HMAC-SHA256(K_rotate, "next" || id || uint64be(generation) || rotationId)`。
 *
 * 乱数ではなく導出にしているのは、 **同じ rotation_id の再送に対して同じ token を
 * 再生成できる**ようにするため。 これがあるので raw token を DB / Redis に置かずに
 * 「DB は更新済みだがクライアントが応答を受け取れなかった」 状態を吸収できる (§11.3-6)。
 */
export function deriveNextSecret(
  rotateKey: Buffer,
  id: string,
  nextGeneration: number,
  rotationId: string,
): string {
  const generationBytes = Buffer.alloc(8);
  generationBytes.writeBigUInt64BE(BigInt(nextGeneration));
  return createHmac("sha256", rotateKey)
    .update("next")
    .update(id)
    .update(generationBytes)
    .update(rotationId)
    .digest("base64url");
}

/** hex ハッシュの定数時間比較。 長さ違いは false (timingSafeEqual が throw するため)。 */
export function secretHashEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
