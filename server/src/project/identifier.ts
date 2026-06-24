/**
 * SQL 識別子 (テーブル名 / カラム名) の境界検証。
 *
 * 動的 DDL (schema-migrator) はプロジェクト定義の列名を識別子としてクォート補間する。
 * `"` を含む列名は識別子クォートを抜けて DDL injection になりうるため、 補間の手前で
 * 厳格に検証する。 不正値は無言で通さず即 throw する (= 設定不備の無言通過禁止 RULE §7.1)。
 *
 * 許可: 先頭が英字/アンダースコア、 以降は英数字/アンダースコアのみ。 PostgreSQL の
 * 非クォート識別子と同じ形にし、 クォート抜け (`"`)・空白・記号・予約語を一切許さない。
 */

// PostgreSQL の識別子長上限 (NAMEDATALEN-1)。 これを超えると DDL 側で暗黙に
// 切り詰められ、 別カラムと衝突しうるため境界で弾く。
const MAX_IDENTIFIER_LENGTH = 63;

const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// 補間先で意味を持つ予約語 (大文字小文字無視)。 列名/表名として現れたら拒否する。
const RESERVED_WORDS = new Set([
  "select", "insert", "update", "delete", "drop", "alter", "create",
  "table", "from", "where", "user", "users", "grant", "revoke",
]);

/**
 * SQL 識別子として安全か検証する。 不正なら Error を throw する。
 *
 * @param name 検証対象の識別子 (テーブル名 / カラム名)
 * @param kind エラーメッセージ用の種別ラベル (例: "column", "table")
 */
export function assertSafeIdentifier(name: string, kind: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`invalid ${kind} identifier: empty`);
  }
  if (name.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(
      `invalid ${kind} identifier "${name}": length ${name.length} exceeds ${MAX_IDENTIFIER_LENGTH}`,
    );
  }
  if (!IDENTIFIER_REGEX.test(name)) {
    throw new Error(
      `invalid ${kind} identifier "${name}": must match ${IDENTIFIER_REGEX.source}`,
    );
  }
  if (RESERVED_WORDS.has(name.toLowerCase())) {
    throw new Error(`invalid ${kind} identifier "${name}": reserved word`);
  }
}

export { MAX_IDENTIFIER_LENGTH, IDENTIFIER_REGEX };
