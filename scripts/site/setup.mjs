// Excubitor の拠点導入 (bootstrap) が呼ぶセットアップ入口。
// 引数なし・非対話で、 Cernere backend と login frontend を起動可能な状態にする (常駐起動は Excubitor が行う)。
//
// 1. scripts/bootstrap.mjs --server-only (submodule 取得 → vestigium ビルド → server install + build)。
//    migration は従来どおり server 起動時に走るので、 ここでは流さない。
// 2. scripts/site/build-frontend.mjs (frontend install + 静的ビルド)。 cernere-frontend は vite preview で配る。
// Excubitor は shell 無しで起動し、 拠点の非対話環境では PATH に npm が無いことがあるため、
// 実行中の Node と同じディレクトリ (npm の同梱先) を PATH の先頭に置いて呼ぶ。

import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "./lib/run-process.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
const env = {
  ...process.env,
  [pathKey]: [dirname(process.execPath), process.env[pathKey]].filter(Boolean).join(delimiter),
  CI: "true",
  GIT_TERMINAL_PROMPT: "0",
  npm_config_yes: "true",
};

const steps = [
  [join(root, "scripts", "bootstrap.mjs"), "--server-only"],
  [join(root, "scripts", "site", "build-frontend.mjs")],
];

for (const step of steps) {
  const code = await runProcess(process.execPath, step, { cwd: root, env });
  if (code !== 0) {
    console.error(`[site-setup] ${step.slice(0, 1).map((p) => p.slice(root.length)).join("")} failed (${code})`);
    process.exit(code);
  }
}
