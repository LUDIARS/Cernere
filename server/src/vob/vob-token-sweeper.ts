/**
 * 期限切れの V.O.B 登録トークンを回収する定期処理 (1 時間ごと、期限から 1 日で削除)。
 * 失敗は認証処理に影響させず記録だけする。
 * @implements SPEC-VOB-DISCORD-REGISTRATION
 */
import { devError } from "../logging/dev-logger.js";
import { sweepVobTokens } from "./vob-token-store.js";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

export function startVobTokenSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    sweepVobTokens().catch((err) => devError("vob.token.sweep.failed", err, {}));
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}
