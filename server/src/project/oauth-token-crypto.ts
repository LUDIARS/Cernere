/**
 * project_oauth_tokens の access/refresh トークン列の保存時暗号化。
 *
 * Cernere を個人データの単一情報源とするため `project_oauth_tokens` には
 * LUDIARS 全サービス分の第三者 OAuth トークンが集約される。最重要機微テーブル
 * なので `users.google_*` と同じ規律 (`encryptSecret()` / `decryptSecret()`,
 * AES-256-GCM) で保存時暗号化する (RULE.md §7.2)。
 *
 * 既存平文行 (暗号化導入前に書かれた行) の移行は lazy 方式:
 *   - read 時は `decryptSecret()` の移行シムが `v1:` 接頭辞の無い値を平文として
 *     そのまま返す。
 *   - 次回 write (UPSERT) で新しい値を必ず `encryptSecret()` 経由で書くため、
 *     行は自然に暗号化形式へ移行する。
 */

import { encryptSecret, decryptSecret } from "../lib/crypto/secret-box.js";

/**
 * 保存前にトークンを暗号化する。null/undefined は透過 (列を NULL のまま保つ)。
 * 鍵未設定なら `encryptSecret()` が throw する (fail-closed、平文フォールバック無し)。
 */
export function encryptToken(token: string | null | undefined): string | null {
  if (token == null) return null;
  return encryptSecret(token);
}

/**
 * 保存済みトークンを復号する。
 * - `v1:` 接頭辞の無い値は移行前の平文とみなしてそのまま返す (lazy migration)。
 * - `v1:` 形式が改ざん/鍵不一致で復号失敗した場合は `decryptSecret()` が throw する
 *   (暗号文を平文と取り違えて返さない)。
 */
export function decryptToken(stored: string | null | undefined): string | null {
  if (stored == null) return null;
  return decryptSecret(stored);
}
