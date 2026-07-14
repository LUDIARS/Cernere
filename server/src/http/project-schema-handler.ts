/**
 * プロジェクトスキーマ export REST ハンドラ
 *
 * Foedus (LUDIARS のクロスサービス契約 / PII レビューア) は、これまで
 * コミット済み JSON ファイル (Foedus/schemas/vantan_user.json) からスキーマ
 * shape (カラム名/型/module 構成) を読んでいたが、PII フィールド構造が
 * 恒久的な git 記録として残ること自体がセキュリティ上の懸念となったため、
 * レビュー時に Cernere からライブ取得する方式に切り替える。
 *
 * このハンドラが返すのはスキーマ定義 (shape) のみ — `project_data_<key>`
 * の実データ行は一切クエリ・返却しない (project/service.ts の
 * exportProjectSchemaDefinitions が managedProjects のみを参照する)。
 *
 *   GET /api/admin/projects/schema-export         全 active プロジェクト
 *   GET /api/admin/projects/schema-export?key=X   指定プロジェクト (inactive でも返す)
 *
 * 認可は passkey export と同一ポリシー (admin ユーザー or project/service
 * token) — ../http/export-auth.ts の requireExportAuth を共有する。
 */

import { exportProjectSchemaDefinitions } from "../project/service.js";
import { requireExportAuth } from "./export-auth.js";
import { devLog } from "../logging/dev-logger.js";

interface RouteResult { status: string; data: unknown }

export async function exportProjectSchemas(authHeader: string, query: string): Promise<RouteResult> {
  await requireExportAuth(authHeader);

  const key = new URLSearchParams(query).get("key") ?? undefined;
  const projects = await exportProjectSchemaDefinitions(key);

  devLog("project.schema-export", { count: projects.length, key: key ?? null });
  return { status: "200 OK", data: { projects } };
}
