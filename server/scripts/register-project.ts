/**
 * 管理プロジェクト登録 CLI
 *
 * ProjectDefinition JSON ファイル (project.key / project.name / 必要なら
 * user_data.columns 等) を渡して registerProject() を直接呼び出し、
 * clientId / clientSecret を表示する。clientSecret はここでしか取得できない
 * (DB には bcrypt ハッシュのみ保存され、後から読み出す手段は無い)。
 *
 * 通常の管理者操作は管理者ユーザーの WS セッション経由の
 * managed_project.register コマンド (commands.ts, requireSystemAdmin) で
 * 行うが、それには「ログイン済み管理者の対話セッション」が要る。
 * このスクリプトは自前で持たない外部サービス (例: 施設予約サービス Aedilis) の
 * 最小構成プロジェクトを一回限りで登録するための、DB に直接アクセスする
 * オペレータ用 CLI (register-oidc-client.ts と同じパターン)。
 *
 * 使い方 (server/ で実行、環境変数 DATABASE_URL が対象 DB を指している必要あり):
 *   tsx scripts/register-project.ts --file ./aedilis-schema.json
 *
 * 最小定義ファイル例 (user_data.columns 無し = 純粋な読み取り専用コンシューマ):
 *   {
 *     "project": {
 *       "key": "aedilis",
 *       "name": "Aedilis",
 *       "description": "施設予約サービス"
 *     }
 *   }
 *
 * 出力される client_id / client_secret は、登録対象サービス側の Infisical
 * secret (例: CERNERE_CLIENT_ID / CERNERE_CLIENT_SECRET、キー名はサービスの
 * 実装に合わせる) に保存し、/ws/project 接続の認証情報として使わせること。
 * client_secret は再表示できないため、紛失時は再登録 (delete → register) が必要。
 */

import fs from "node:fs";
import { registerProject } from "../src/project/service.js";

function parseArgs(argv: string[]): { file: string } {
  let file = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") file = argv[++i] ?? "";
  }
  return { file };
}

async function main(): Promise<void> {
  const { file } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error("usage: tsx scripts/register-project.ts --file <definition.json>");
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`file not found: ${file}`);
    process.exit(1);
  }

  const json = JSON.parse(fs.readFileSync(file, "utf-8"));
  const result = await registerProject(json);

  console.log(`\n${result.message}:\n`);
  console.log(`  key            : ${result.key}`);
  if ("name" in result) console.log(`  name           : ${result.name}`);

  if ("clientSecret" in result) {
    // 新規登録時のみ clientId/clientSecret が発行される (再activate 時は既存値を維持)。
    console.log(`  client_id      : ${result.clientId}`);
    console.log(`  client_secret  : ${result.clientSecret}   <-- shown ONCE, store it in Infisical now`);
    console.log(`  table_created  : ${result.tableCreated}`);
  } else {
    console.log(`  (project was reactivated — existing client_id/client_secret unchanged, not re-shown)`);
  }
  console.log(`  columns_added  : ${result.columnsAdded.join(", ") || "(none)"}`);
  console.log("\nStore client_id/client_secret in Infisical for the consuming service's /ws/project auth config.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("registration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
