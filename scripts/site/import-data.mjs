// Excubitor の data-import 入口: --input <Taildrop 絶対パス> --sha256 <hex>。
// bundle の sha256・service・形式版・dump の sha256 を検証してから、 既存 DB を
// <db>_backup_<UTC> へ退避して新しい DB へ pg_restore し、 表ごとの行数を照合する。
// 失敗時は新 DB を消して退避した DB を元の名前へ戻す (spec/setup/site-data-transfer.md)。

import { runServerScript } from "./lib/run-server-script.mjs";

process.exitCode = await runServerScript("site-data-import", "import-cli.ts", process.argv.slice(2));
