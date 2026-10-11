// Excubitor の site hook 共通の子プロセス起動。 shell を介さず、 終了コードを返す。
// Ex から SIGTERM / SIGINT を受けたら子へ転送し、 子を残さない。

import { spawn } from "node:child_process";

export function runProcess(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    const forward = (signal) => child.kill(signal);
    process.on("SIGTERM", forward);
    process.on("SIGINT", forward);
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      process.off("SIGTERM", forward);
      process.off("SIGINT", forward);
      resolve(signal ? 1 : exitCode ?? 1);
    });
  });
}
