// data-export / data-import の入口から server/scripts/site-data/*.ts を実行する。
// 実処理は server の TypeScript (Vault からの DATABASE_URL 取得・postgres client・契約) を使うため、
// setup が入れた server の tsx を同じ Node の --import ローダとして使う (追加の子プロセスを挟まない)。

import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runProcess } from "./run-process.mjs";

const serverDir = fileURLToPath(new URL("../../../server/", import.meta.url));

export async function runServerScript(label, script, args) {
  let loader;
  try {
    loader = pathToFileURL(createRequire(join(serverDir, "package.json")).resolve("tsx/esm")).href;
  } catch {
    console.error(`[${label}] server dependencies are missing; run scripts/site/setup.mjs first`);
    return 1;
  }
  return runProcess(process.execPath, ["--import", loader, join(serverDir, "scripts", "site-data", script), ...args], {
    cwd: serverDir,
  });
}
