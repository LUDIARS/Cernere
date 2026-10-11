// Excubitor の data-export 入口: --output <絶対パス>。
// 停止中の Cernere の Postgres を pg_dump -Fc で論理ダンプし、 ヘッダ付きの 1 ファイル bundle にする。
// 形式と設定は spec/setup/site-data-transfer.md。 Redis (セッション) は含めない。

import { runServerScript } from "./lib/run-server-script.mjs";

process.exitCode = await runServerScript("site-data-export", "export-cli.ts", process.argv.slice(2));
