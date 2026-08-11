// clean clone / git worktree から Cernere をビルド可能な状態にする。
//
// 背景: server は @ludiars/vestigium を file:../lib/vestigium で参照するが、
// lib/vestigium は git submodule なので `git clone` (--recurse-submodules 無し) や
// `git worktree add` では空のまま残る。 さらに submodule を init しただけでも
// server の `npm ci` は失敗する — vestigium の prepare が `npx tsc` を呼ぶのに
// vestigium 側の node_modules が無く、 npx が tsc を解決できないため。
//
// そのため「submodule を取得 → vestigium を単独でビルド → 各パッケージを install」
// の順序が必要になる。 CI (.github/workflows/compile-check.yml) も同じ順序を踏む。

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** install が必要な npm パッケージ (vestigium ビルド後に処理する)。 */
const INSTALL_DIRECTORIES = [".", "server", "frontend", "packages/env-cli", "packages/id-cache"];

// NODE_ENV=production のシェルでは npm ci が devDependencies を落とし、
// typescript が入らないまま build に進んで失敗する。 bootstrap は開発用の
// セットアップなので、 環境変数に関わらず devDependencies を必ず入れる。
const CI_ARGS = ["ci", "--include=dev"];

function run(command, args, cwd) {
  const where = cwd === root ? "." : cwd.slice(root.length + 1);
  console.log(`[bootstrap] ${where}$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
}

function syncSubmodules() {
  if (!existsSync(join(root, ".gitmodules"))) return;
  run("git", ["submodule", "update", "--init", "--recursive"], root);
}

// vestigium の prepare は node_modules 未展開だと npx tsc を解決できないので、
// --ignore-scripts で prepare を止めてから build を明示的に呼ぶ。
function buildVestigium() {
  const vestigium = join(root, "lib", "vestigium");
  if (!existsSync(join(vestigium, "package.json"))) {
    throw new Error(
      "lib/vestigium が空です。 git submodule の取得に失敗しています " +
        "(git submodule update --init --recursive を手動で確認してください)。",
    );
  }
  run("npm", [...CI_ARGS, "--ignore-scripts"], vestigium);
  run("npm", ["run", "build"], vestigium);
}

function installPackages() {
  for (const directory of INSTALL_DIRECTORIES) {
    run("npm", CI_ARGS, join(root, directory));
  }
}

try {
  syncSubmodules();
  buildVestigium();
  installPackages();
  console.log("[bootstrap] 完了。 npm run build --prefix server が通る状態です。");
} catch (error) {
  console.error(`[bootstrap] 失敗: ${error.message}`);
  process.exit(1);
}
