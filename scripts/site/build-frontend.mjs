// setup の一段: frontend の依存を入れて静的ビルド (frontend/dist) を作る。
// 拠点の cernere-frontend は vite preview でこの dist を配る (Vite dev server を常駐させない)。
// npm は scripts/bootstrap.mjs と同じく PATH 上のものを使う (setup.mjs が Node 同梱の npm を先頭に置く)。

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const frontend = fileURLToPath(new URL("../../frontend/", import.meta.url));

function npm(args) {
  console.log(`[site-setup] frontend$ npm ${args.join(" ")}`);
  // Windows の npm は npm.cmd なので bootstrap.mjs と同じく shell 経由になる (引数は固定値のみ)。
  execFileSync("npm", args, { cwd: frontend, stdio: "inherit", shell: process.platform === "win32" });
}

try {
  npm(["ci", "--include=dev"]);
  npm(["run", "build"]);
  console.log(`[site-setup] frontend built: ${join("frontend", "dist")}`);
} catch (error) {
  console.error(`[site-setup] frontend build failed: ${error.message}`);
  process.exit(1);
}
