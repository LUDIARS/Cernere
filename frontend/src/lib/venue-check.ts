/**
 * 登録画面の会場確認の進め方 (spec/feature/venue-network-registration.md §2)。
 *
 *   1. Cernere で challenge を取る (kiosk が無ければ unavailable)
 *   2. 全 kiosk の lanUrl へ nonce を送る。どれにも届かなければ unreachable (会場の Wi-Fi の案内を出す)
 *   3. 約 2 秒ごとに状態を見る。verified で完了、expired で終了
 *
 * verified 以外のときも、利用者は会場外の例外経路 (venueChallengeId なし、pending) で登録を続けられる。
 * 画面に依存しないので、通信と待ちは deps で受ける。
 */

import type { VenueKiosk, VenueStart, VenueStatus } from "./venue-registration-api";

export type VenuePhase = "starting" | "checking" | "unreachable" | "verified" | "expired" | "unavailable";

export interface VenueCheckState { phase: VenuePhase; challengeId: string | null }

export const VENUE_POLL_INTERVAL_MS = 2000;

export interface VenueCheckDeps {
  start(): Promise<VenueStart>;
  sendToKiosk(kiosk: VenueKiosk, nonce: string): Promise<boolean>;
  status(challengeId: string): Promise<VenueStatus>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** nonce を送った結果。1 つでも届けば確認待ち、どれにも届かなければ会場の外とみなして案内する。 */
export function phaseAfterSend(delivered: readonly boolean[]): VenuePhase {
  return delivered.some(Boolean) ? "checking" : "unreachable";
}

/** ポーリング結果。pending の間は送信時の判断 (checking / unreachable) を保つ。 */
export function phaseAfterStatus(status: VenueStatus, current: VenuePhase): VenuePhase {
  if (status === "verified") return "verified";
  if (status === "expired") return "expired";
  return current;
}

/** 会場確認済みのときだけ signup に venueChallengeId を付ける。それ以外は例外経路 (付けない)。 */
export function venueChallengeForSignup(state: VenueCheckState): string | undefined {
  return state.phase === "verified" && state.challengeId ? state.challengeId : undefined;
}

export function isVenueCheckFinal(phase: VenuePhase): boolean {
  return phase === "verified" || phase === "expired" || phase === "unavailable";
}

/** 確認を 1 回分進める。isCancelled が true になったら更新せずに止まる。 */
export async function runVenueCheck(deps: VenueCheckDeps, onUpdate: (state: VenueCheckState) => void,
  isCancelled: () => boolean): Promise<VenueCheckState> {
  let state: VenueCheckState = { phase: "starting", challengeId: null };
  const update = (next: VenueCheckState) => { state = next; if (!isCancelled()) onUpdate(next); };
  update(state);

  let started: VenueStart;
  try {
    started = await deps.start();
  } catch {
    update({ phase: "unavailable", challengeId: null });
    return state;
  }
  if (isCancelled()) return state;

  const delivered = await Promise.all(started.kiosks.map((kiosk) => deps.sendToKiosk(kiosk, started.nonce)));
  update({ phase: phaseAfterSend(delivered), challengeId: started.challengeId });

  const deadline = Date.parse(started.expiresAt);
  while (!isCancelled()) {
    if (Number.isFinite(deadline) && deps.now() >= deadline) {
      update({ ...state, phase: "expired" });
      break;
    }
    let status: VenueStatus;
    try {
      status = await deps.status(started.challengeId);
    } catch {
      // 一時的な失敗は次の周期で見直す (期限で必ず止まる)。
      await deps.sleep(VENUE_POLL_INTERVAL_MS);
      continue;
    }
    const phase = phaseAfterStatus(status, state.phase);
    if (phase !== state.phase) update({ ...state, phase });
    if (isVenueCheckFinal(phase)) break;
    await deps.sleep(VENUE_POLL_INTERVAL_MS);
  }
  return state;
}
