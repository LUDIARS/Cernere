/**
 * secret-box — DB に永続化する機密値 (OAuth トークン / TOTP 秘密鍵等) の
 * 保存時暗号化 (encryption at rest)。
 *
 * AES-256-GCM (AEAD) で暗号化し、復号鍵 (`CERNERE_SECRET_KEY`) はプロセスメモリ
 * のみに保持する。AIFormat RULE.md §7.2「シークレットは平文でファイル/DB に保存
 * しない」に対応する。
 *
 * 出力形式 (text カラムにそのまま格納できる単一文字列):
 *   v1:<iv_b64url>:<tag_b64url>:<ciphertext_b64url>
 *
 * - 鍵未設定で `encryptSecret()` を呼ぶと throw する (fail-closed)。平文で書き込む
 *   フォールバックは持たない。
 * - `decryptSecret()` は `v1:` 接頭辞が無い文字列を「移行前の平文」とみなして
 *   そのまま返す (既存行の段階的移行のためのシム)。
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // GCM 推奨 96-bit nonce
const KEY_BYTES = 32; // AES-256

const ENV_KEY = "CERNERE_SECRET_KEY";

let cachedKey: Buffer | null = null;

/**
 * `CERNERE_SECRET_KEY` を 32 byte の鍵として解決する。
 * base64 / hex / 生 32 文字 utf8 のいずれかを受け付ける。鍵が無効なら throw。
 */
function resolveKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env[ENV_KEY];
  if (!raw) {
    throw new Error(
      `${ENV_KEY} is not set — refusing to persist a secret in plaintext (RULE.md §7.2)`,
    );
  }
  const key = decodeKey(raw);
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${ENV_KEY} must decode to ${KEY_BYTES} bytes (got ${key.length})`,
    );
  }
  cachedKey = key;
  return key;
}

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  // base64 / base64url を試す
  const b64 = Buffer.from(trimmed, "base64");
  if (b64.length === KEY_BYTES) return b64;
  // 最後の手段: 生の utf8 (ちょうど 32 文字のとき)
  return Buffer.from(trimmed, "utf8");
}

const b64u = (b: Buffer): string => b.toString("base64url");

/** 機密値を暗号化して text カラム格納用の単一文字列を返す。鍵未設定なら throw。 */
export function encryptSecret(plaintext: string): string {
  const key = resolveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${b64u(iv)}:${b64u(tag)}:${b64u(ct)}`;
}

/**
 * `encryptSecret()` の出力を復号する。
 * - `v1:` 接頭辞が無い値は移行前の平文とみなしてそのまま返す。
 * - 形式不正・改ざん検出時は throw。
 */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(`${VERSION}:`)) {
    // 移行前の平文 (暗号化導入より前に書かれた行)
    return stored;
  }
  const parts = stored.split(":");
  if (parts.length !== 4) {
    throw new Error("secret-box: malformed ciphertext");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const key = resolveKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64url")),
    decipher.final(),
  ]);
  return pt.toString("utf8");
}

/** null/undefined を透過しつつ暗号化するヘルパ (任意フィールド向け)。 */
export function encryptSecretNullable(
  plaintext: string | null | undefined,
): string | null {
  if (plaintext == null) return null;
  return encryptSecret(plaintext);
}

/** テスト用: 解決済み鍵キャッシュを破棄する。 */
export function _resetKeyCacheForTest(): void {
  cachedKey = null;
}
