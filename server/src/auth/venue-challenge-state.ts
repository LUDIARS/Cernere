import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:87e78b4e */
import augurContract_4c2e98fe from './contracts/venue-challenge-state.contract.js'; /* augur-inject:contract-predicate:782cdcc8 */
import augurContract_52bbdb65 from './contracts/venue-signup-outcome.contract.js'; /* augur-inject:contract-predicate:be177544 */
/**
 * venue challenge の行から、登録画面へ返す状態と signup での扱いを決める (副作用なし)。
 * spec/feature/venue-network-registration.md §2 / §6。
 * @implements SPEC-VENUE-REGISTRATION
 */

export interface VenueChallengeRow {
  id: string;
  expiresAt: Date;
  verifiedAt: Date | null;
  placeId: string | null;
  consumedAt: Date | null;
}

export type VenueChallengeState = "pending" | "verified" | "expired";

/**
 * 登録画面のポーリング結果。lanId / placeId は返さない。
 * 消費済みは再利用できないので expired と同じに見せる (未知の id と区別しない)。
 */
export function venueChallengeState(row: VenueChallengeRow | null, now: Date): VenueChallengeState {
  if (!row || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) return "expired";
  return row.verifiedAt ? "verified" : "pending";
}
// @ts-expect-error augur-inject
venueChallengeState = contract(venueChallengeState, { ...augurContract_4c2e98fe, contractId: 'C-39', mode: 'observe', sample: 1, where: 'server/src/auth/venue-challenge-state.ts:21', rule: 'contract-wrap', id: '4c2e98fe' }); /* augur-inject:contract-wrap:4c2e98fe */

export type VenueSignupOutcome =
  | { kind: "venue"; challengeId: string; placeId: string }
  | { kind: "outside_venue" }
  | { kind: "invalid" };

/**
 * signup の分岐 (§6)。
 *   指定なし                         → outside_venue (従来どおり pending)
 *   verified・未消費・期限内          → venue (active + 組織 member)
 *   指定ありでそれ以外 (未確認など)   → invalid (422。例外経路に黙って落とさない)
 */
export function venueSignupOutcome(venueChallengeId: string | undefined, row: VenueChallengeRow | null, now: Date): VenueSignupOutcome {
  if (venueChallengeId === undefined) return { kind: "outside_venue" };
  if (!row || row.id !== venueChallengeId) return { kind: "invalid" };
  if (venueChallengeState(row, now) !== "verified" || !row.placeId) return { kind: "invalid" };
  return { kind: "venue", challengeId: row.id, placeId: row.placeId };
}
// @ts-expect-error augur-inject
venueSignupOutcome = contract(venueSignupOutcome, { ...augurContract_52bbdb65, contractId: 'C-40', mode: 'observe', sample: 1, where: 'server/src/auth/venue-challenge-state.ts:37', rule: 'contract-wrap', id: '52bbdb65' }); /* augur-inject:contract-wrap:52bbdb65 */
