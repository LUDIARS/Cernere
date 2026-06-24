/**
 * 監査ログ (operation_logs.params) へ書き込む payload から機密値をマスクする。
 *
 * operation_logs は全ユーザ WS コマンドの payload を保存する監査シンクなので、
 * トークン/パスワード/シークレット類がそのまま残ると DB 漏洩時に平文露出する。
 * キー名ベースで再帰的にマスクし、構造 (どのキーが来たか) は監査用に保ったまま
 * 値だけを `[REDACTED]` に置き換える。
 *
 * RULE.md §7「シークレットは平文で保存しない」に対応。
 */

const REDACTED = "[REDACTED]";

/** キー名 (小文字化) に含まれていたらその値をマスクする部分一致リスト。 */
const SENSITIVE_KEY_PARTS = [
  "token",        // accessToken / refreshToken / tokenType / refresh_token ...
  "secret",       // clientSecret / serviceSecret ...
  "password",
  "passwd",
  "credential",
  "authorization",
  "apikey",
  "api_key",
  "totp",
  "privatekey",
  "private_key",
];

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => k.includes(part));
}

/**
 * payload を再帰的に走査し、機密キーの値を `[REDACTED]` に置換した新しい値を返す。
 * 入力は破壊しない (deep copy 相当)。循環参照は想定しない (JSON 由来の payload)。
 */
export function redactSensitive(value: unknown, depth = 0): unknown {
  // 異常に深い構造はそれ以上辿らずマスク (防御的)。
  if (depth > 12) return REDACTED;

  if (Array.isArray(value)) {
    return value.map((v) => redactSensitive(v, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redactSensitive(v, depth + 1);
    }
    return out;
  }
  return value;
}
