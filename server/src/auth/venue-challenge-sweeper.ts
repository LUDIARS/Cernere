/**
 * 期限切れの venue challenge を回収する定期処理 (spec/feature/venue-network-registration.md §5)。
 * 期限から 1 日を過ぎた行を 1 時間ごとに消す。失敗は認証処理に影響させず記録だけする。
 * @implements SPEC-VENUE-REGISTRATION
 */

import { devError } from "../logging/dev-logger.js";
import { purgeExpiredVenueChallenges } from "./venue-challenge-store.js";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export function startVenueChallengeSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    purgeExpiredVenueChallenges().catch((err) => devError("venue.challenge.sweep.failed", err, {}));
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}
