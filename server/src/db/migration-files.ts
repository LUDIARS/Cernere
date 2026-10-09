/**
 * migration ファイルの探索・ステートメント分割・冪等スキップ判定。
 *
 * runMigrations (起動時適用) と migration dry-run (配備前確認) が同じ規則で
 * SQL を解釈するよう、 ここを唯一の実装にする。
 */

import fs from "node:fs";
import path from "node:path";

/**
 * 「既に存在する」系のエラーはスキップして続行する (冪等運用)。
 * 42P01 (relation does not exist) 等、構造不整合のエラーはスキップしない
 *   — テーブル未作成を隠蔽するとデータ破損の原因になるため。
 */
const IGNORABLE_CODES = new Set([
  "42P07",  // duplicate_table (relation already exists)
  "42701",  // duplicate_column
  "42710",  // duplicate_object (index, type, etc.)
  "42P06",  // duplicate_schema
  "42P04",  // duplicate_database
  "23505",  // unique_violation (duplicate key)
  "42P16",  // invalid_table_definition (PK すでにある等、冪等ケース)
]);

export function isIgnorableMigrationError(code: string | undefined): boolean {
  return code !== undefined && IGNORABLE_CODES.has(code);
}

/** migrations/ ディレクトリを探す (見つからなければ第一候補を返す)。 */
export function resolveMigrationsDir(cwd: string = process.cwd()): string {
  const candidates = [
    path.resolve(cwd, "..", "migrations"),
    path.resolve("/app", "migrations"),
    path.resolve(cwd, "migrations"),
  ];
  return candidates.find((d) => fs.existsSync(d)) ?? candidates[0];
}

/** SQL ファイルを番号順に返す。 */
export function listMigrationFiles(migrationsDir: string): string[] {
  return fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
}

export function migrationVersion(file: string): string {
  return file.replace(".sql", "");
}

/**
 * SQL テキストをステートメントに分割。
 *
 * 単純な `;` split だと、文字列リテラルやコメント中に `;` が含まれた
 * (e.g. JSON の description) 際にステートメントが途中で切れてしまう。
 * PostgreSQL の字句に従い以下を文字列とみなしてスキップする:
 *   - 単一引用符 `'...'` (`''` で escape)
 *   - dollar-quote `$tag$...$tag$`
 *   - 行コメント `-- ... \n`
 *   - ブロックコメント `/* ... *​/` (ネスト対応)
 * 二重引用符 `"..."` は識別子なので `;` を含めることは無いが、
 * 一応文字列同様に扱う。
 */
export function splitStatements(sqlText: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  const n = sqlText.length;

  while (i < n) {
    const c = sqlText[i];
    const next = sqlText[i + 1];

    // 行コメント
    if (c === "-" && next === "-") {
      const eol = sqlText.indexOf("\n", i);
      const end = eol === -1 ? n : eol + 1;
      buf += sqlText.slice(i, end);
      i = end;
      continue;
    }

    // ブロックコメント (ネスト対応)
    if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sqlText[j] === "/" && sqlText[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sqlText[j] === "*" && sqlText[j + 1] === "/") {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      buf += sqlText.slice(i, j);
      i = j;
      continue;
    }

    // 単一引用符文字列 ('' は escape)
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sqlText[j] === "'") {
          if (sqlText[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      buf += sqlText.slice(i, j);
      i = j;
      continue;
    }

    // 二重引用符識別子 ("" は escape)
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sqlText[j] === '"') {
          if (sqlText[j + 1] === '"') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      buf += sqlText.slice(i, j);
      i = j;
      continue;
    }

    // dollar-quote ($tag$ ... $tag$)
    if (c === "$") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sqlText.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0]; // 例: $$ or $foo$
        const start = i + tag.length;
        const close = sqlText.indexOf(tag, start);
        const end = close === -1 ? n : close + tag.length;
        buf += sqlText.slice(i, end);
        i = end;
        continue;
      }
    }

    if (c === ";") {
      out.push(buf);
      buf = "";
      i++;
      continue;
    }

    buf += c;
    i++;
  }

  if (buf.length > 0) out.push(buf);

  return out
    .map(stripLeadingComments)
    .filter((s) => s.length > 0);
}

/** ステートメント先頭の `-- コメント行` と空行を除去 */
function stripLeadingComments(raw: string): string {
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("--")) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join("\n").trim();
}
