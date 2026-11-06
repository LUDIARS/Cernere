import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:075061c0 */
import augurContract_1e688a57 from './contracts/access-review-origin.contract.js'; /* augur-inject:contract-predicate:3d05cfb8 */
/**
 * 許可待ち一覧に出す登録経路 (spec/feature/venue-network-registration.md §7)。
 *
 *   outside_venue  会場外からの登録 (例外)。拒否 (locked) を既定の操作にする
 *   venue          会場 LAN 経由で自動許可された。一覧から後で停止できる
 *   null           本機能以前の登録 (従来どおり)
 * 未知の値は例外 (会場外) 側に倒す。
 * @implements SPEC-VENUE-REGISTRATION
 */

export type RegistrationOrigin = "venue" | "outside_venue" | null;

export interface AccessReviewOrigin {
  registrationOrigin: RegistrationOrigin;
  /** 会場外からの登録で、管理者が例外として判断するもの */
  exception: boolean;
  /** 画面が既定にする操作。null は既定なし (従来どおり) */
  defaultDecision: "reject" | null;
}

export function accessReviewOrigin(value: unknown): AccessReviewOrigin {
  if (value === null || value === undefined) return { registrationOrigin: null, exception: false, defaultDecision: null };
  if (value === "venue") return { registrationOrigin: "venue", exception: false, defaultDecision: null };
  return { registrationOrigin: "outside_venue", exception: true, defaultDecision: "reject" };
}
// @ts-expect-error augur-inject
accessReviewOrigin = contract(accessReviewOrigin, { ...augurContract_1e688a57, contractId: 'C-41', mode: 'observe', sample: 1, where: 'server/src/auth/access-review-origin.ts:21', rule: 'contract-wrap', id: '1e688a57' }); /* augur-inject:contract-wrap:1e688a57 */
