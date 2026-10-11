// Excubitor の拠点導入 (bootstrap) が呼ぶセットアップ入口。
// 引数なし・非対話で、 Cernere backend を起動可能な状態にする (常駐起動は Excubitor が行う)。
//
// 実処理は既存の scripts/bootstrap.mjs --server-only (submodule 取得 → vestigium ビルド →
// server install + build) に任せる。 migration は従来どおり server 起動時に走るので、 ここでは流さない。
// Excubitor は shell 無しで起動し、 拠点の非対話環境では PATH に npm が無いことがあるため、
// 実行中の Node と同じディレクトリ (npm の同梱先) を PATH の先頭に置いて呼ぶ。

import { spawn } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
const env = {
  ...process.env,
  [pathKey]: [dirname(process.execPath), process.env[pathKey]].filter(Boolean).join(delimiter),
  CI: "true",
  GIT_TERMINAL_PROMPT: "0",
  npm_config_yes: "true",
};

const code = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(root, "scripts", "bootstrap.mjs"), "--server-only"], {
    cwd: root,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.once("error", reject);
  child.once("close", (exitCode, signal) => resolve(signal ? 1 : exitCode ?? 1));
});

if (code !== 0) {
  console.error(`[site-setup] scripts/bootstrap.mjs --server-only failed (${code})`);
  process.exit(code);
}
