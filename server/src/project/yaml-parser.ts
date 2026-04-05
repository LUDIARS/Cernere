/**
 * プロジェクト YAML パーサー & バリデーション
 *
 * 軽量 YAML パーサー (依存なし) + バリデーション
 */

import { AppError } from "../error.js";
import type { ProjectYaml, ColumnType } from "./types.js";
import { COLUMN_TYPE_MAP } from "./types.js";

const VALID_KEY_PATTERN = /^[a-z][a-z0-9_]{1,62}$/;

const VALID_COLUMN_TYPES = new Set(Object.keys(COLUMN_TYPE_MAP));

/**
 * YAML テキストをパースして ProjectYaml を返す
 *
 * 簡易 YAML パーサー: ネスト2階層 + キーバリューのみサポート
 * フル YAML が必要な場合は js-yaml を追加
 */
export function parseProjectYaml(yamlText: string): ProjectYaml {
  const lines = yamlText.split("\n");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: Record<string, any> = {};

  let section = "";
  let subsection = "";
  let item = "";

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, ""); // コメント除去
    if (line.trim() === "") continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    if (indent === 0 && trimmed.endsWith(":")) {
      section = trimmed.slice(0, -1);
      result[section] = result[section] ?? {};
      subsection = "";
      item = "";
    } else if (indent === 2 && trimmed.endsWith(":")) {
      subsection = trimmed.slice(0, -1);
      result[section][subsection] = result[section][subsection] ?? {};
      item = "";
    } else if (indent === 4 && trimmed.endsWith(":")) {
      item = trimmed.slice(0, -1);
      result[section][subsection] = result[section][subsection] ?? {};
      (result[section][subsection] as Record<string, Record<string, string>>)[item] =
        (result[section][subsection] as Record<string, Record<string, string>>)[item] ?? {};
    } else if (trimmed.includes(":")) {
      const colonIdx = trimmed.indexOf(":");
      const key = trimmed.slice(0, colonIdx).trim();
      let value = trimmed.slice(colonIdx + 1).trim();

      // 引用符除去
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (indent <= 2 && section && subsection === "") {
        // section 直下の key: value (例: project.key)
        if (!result[section]) result[section] = {};
        (result[section] as Record<string, string>)[key] = value;
      } else if (indent <= 4 && section && subsection) {
        if (item) {
          // 4段目以降: columns.{item}.{key}: {value}
          const items = result[section][subsection] as Record<string, Record<string, string>>;
          if (!items[item]) items[item] = {};
          items[item][key] = value;
        } else {
          // 2段目: user_data.columns 直下のキー (カラム名)
          // indent=4 でコロン終わりでない = key: value
          (result[section][subsection] as Record<string, string>)[key] = value;
        }
      }
    }
  }

  // ProjectYaml に変換
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const projectSection = (result as any)["project"] as Record<string, string> | undefined;
  if (!projectSection?.["key"] || !projectSection?.["name"]) {
    throw AppError.badRequest("YAML must contain project.key and project.name");
  }

  const definition: ProjectYaml = {
    project: {
      key: projectSection["key"],
      name: projectSection["name"],
      description: projectSection["description"],
    },
  };

  // user_data.columns
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userData = (result as any)["user_data"] as Record<string, unknown> | undefined;
  if (userData?.["columns"]) {
    const columns: ProjectYaml["user_data"] = { columns: {} };
    const rawColumns = userData["columns"] as Record<string, Record<string, string>>;

    for (const [colName, colProps] of Object.entries(rawColumns)) {
      if (typeof colProps !== "object") continue;
      const colType = (colProps["type"] ?? "text") as ColumnType;

      if (!VALID_COLUMN_TYPES.has(colType)) {
        throw AppError.badRequest(`Invalid column type '${colType}' for column '${colName}'`);
      }

      columns.columns[colName] = {
        type: colType,
        nullable: colProps["nullable"] !== "false",
        description: colProps["description"],
        default_value: colProps["default_value"],
      };
    }

    definition.user_data = columns;
  }

  return definition;
}

/**
 * プロジェクトキーのバリデーション
 */
export function validateProjectKey(key: string): void {
  if (!VALID_KEY_PATTERN.test(key)) {
    throw AppError.badRequest(
      `Invalid project key '${key}'. Must be lowercase alphanumeric + underscore, 2-63 chars, starting with a letter.`,
    );
  }
}
