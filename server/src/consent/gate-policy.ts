/**
 * 移行モード (consent_mode) と同意の充足から、関門の動作を決める (設計書 §6)。
 *
 *   off      判定しない (宣言の検証だけ)
 *   warn     判定し、未充足でも通す。consent.would_block を記録する
 *   enforce  未充足なら authCode を出さず /consent へ
 */

import type { ConsentMode } from "./declaration-schema.js";
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:06c33fe1 */
import augurContract_797fa2b0 from './contracts/gate-policy.contract.js'; /* augur-inject:contract-predicate:3e45f5ce */

export type GateAction = "pass" | "warn" | "block";

/** 契約 C-25 (server/src/consent/contracts/gate-policy.contract.ts) は augur inject が包む。 */
export function decideConsentGate(mode: ConsentMode, satisfied: boolean): GateAction {
  if (mode === "off" || satisfied) return "pass";
  return mode === "warn" ? "warn" : "block";
}
// @ts-expect-error augur-inject
decideConsentGate = contract(decideConsentGate, { ...augurContract_797fa2b0, contractId: 'C-25', mode: 'observe', sample: 1, where: 'server/src/consent/gate-policy.ts:14', rule: 'contract-wrap', id: '797fa2b0' }); /* augur-inject:contract-wrap:797fa2b0 */
