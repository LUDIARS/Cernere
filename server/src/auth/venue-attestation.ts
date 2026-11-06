/**
 * 会場ネットワーク限定の新規登録で kiosk (Ostiarius) が送る purpose:"registration" attestation の検証
 * (spec/feature/venue-network-registration.md §3)。
 *
 * 形式・署名・kiosk 鍵の扱いは SPEC-MFA-ONSITE と共有する (auth/onsite-attestation.ts の
 * parseOnsiteAttestation / verifyKioskSignature)。Os が保証するのは「この nonce が会場 LAN 上の端末から
 * Os へ届いた」ことだけなので、sub は null 必須で本人は扱わない。
 *
 * 判定は副作用を持たない。参照の取得 (gatherVenueEvidence) と判定 (decideVenueAttestation) を分け、
 * 受理後の nonce の原子的な遷移は呼出側 (venue-registration.ts) が行う。
 * @implements SPEC-VENUE-REGISTRATION
 */

import { ONSITE_FRESHNESS_MS, attestationPurpose, onsiteAttestationError, parseOnsiteAttestation, verifyKioskSignature,
  type OnsiteAttestationErrorCode, type OnsiteKioskKey, type ParsedAttestation } from "./onsite-attestation.js";
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:1b2ef591 */
import augurContract_f941676e from './contracts/venue-attestation.contract.js'; /* augur-inject:contract-predicate:06ec43e2 */

/** challenge の状態 (nonce hash で引いた結果)。 */
export type VenueNonceLookup =
  | { state: "unknown" }
  | { state: "used" }
  | { state: "active"; challengeId: string };

export interface VenueAttestationDeps {
  findKiosk(lanId: string): Promise<OnsiteKioskKey | null>;
  lookupNonce(nonce: string): Promise<VenueNonceLookup>;
  /** kiosk の placeId が organizations.id に解決できるか。 */
  organizationExists(placeId: string): Promise<boolean>;
  now(): number;
}

/** 判定に要る事実。kiosk が無い・署名が合わないときは後段を引かない。 */
export interface VenueAttestationEvidence {
  parsed: ParsedAttestation;
  kiosk: OnsiteKioskKey | null;
  signatureValid: boolean;
  challenge: VenueNonceLookup | null;
  organizationKnown: boolean;
  now: number;
}

export interface AcceptedVenueAttestation {
  challengeId: string;
  nonce: string;
  lanId: string;
  /** 会場の組織。attestation の placeId ではなく、admin が登録した kiosk の placeId。 */
  placeId: string;
  issuedAt: number;
  acceptedAt: number;
}

export type VenueAttestationDecision =
  | { ok: true; accepted: AcceptedVenueAttestation }
  | { ok: false; code: OnsiteAttestationErrorCode };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** placeId は organizations.id (UUID) とする (§4)。UUID でない値は DB を引かずに未知とする。 */
export function isOrganizationPlaceId(placeId: string): boolean {
  return UUID.test(placeId);
}

/** §3 の 1〜7 をこの順に判定する。 */
export function decideVenueAttestation(evidence: VenueAttestationEvidence): VenueAttestationDecision {
  const { parsed: { payload }, kiosk, challenge } = evidence;
  const fail = (code: OnsiteAttestationErrorCode): VenueAttestationDecision => ({ ok: false, code });

  // 1. signature with a registered, active kiosk key
  if (!kiosk) return fail("unknown_kiosk");
  if (kiosk.status !== "active") return fail("revoked_kiosk");
  if (!evidence.signatureValid) return fail("invalid_signature");

  // 2. purpose: mfa / attendance attestations never register an account
  if (attestationPurpose(payload) !== "registration") return fail("purpose_mismatch");

  // 3. binding: a live venue challenge, and no subject
  if (!challenge || challenge.state === "unknown") return fail("nonce_unknown");
  if (challenge.state === "used") return fail("nonce_used");
  if (payload.sub !== null) return fail("subject_mismatch");

  // 4. freshness (the one-time transition is committed by the caller)
  if (Math.abs(evidence.now - payload.issuedAt) > ONSITE_FRESHNESS_MS) return fail("stale");

  // 5. assurance: network presence only
  if (payload.method !== "lan" || payload.assurance !== "network") return fail("assurance_insufficient");

  // 6. place: the kiosk's registered place
  if (payload.placeId !== kiosk.placeId) return fail("place_not_allowed");

  // 7. organization: the kiosk's place resolves to an organization
  if (!evidence.organizationKnown) return fail("organization_unknown");

  return {
    ok: true,
    accepted: {
      challengeId: challenge.challengeId, nonce: payload.nonce, lanId: kiosk.lanId, placeId: kiosk.placeId,
      issuedAt: payload.issuedAt, acceptedAt: evidence.now,
    },
  };
}
// @ts-expect-error augur-inject
decideVenueAttestation = contract(decideVenueAttestation, { ...augurContract_f941676e, contractId: 'C-38', mode: 'observe', sample: 1, where: 'server/src/auth/venue-attestation.ts:63', rule: 'contract-wrap', id: 'f941676e' }); /* augur-inject:contract-wrap:f941676e */

/** 判定に要る事実だけを引く。署名が通るまで challenge と組織は引かない。 */
export async function gatherVenueEvidence(token: unknown, deps: VenueAttestationDeps): Promise<VenueAttestationEvidence> {
  const parsed = parseOnsiteAttestation(token);
  const now = deps.now();
  const kiosk = await deps.findKiosk(parsed.payload.lanId);
  const signatureValid = kiosk?.status === "active" && verifyKioskSignature(parsed, kiosk.publicKeyPem);
  if (!kiosk || !signatureValid) return { parsed, kiosk, signatureValid, challenge: null, organizationKnown: false, now };
  const challenge = await deps.lookupNonce(parsed.payload.nonce);
  const organizationKnown = isOrganizationPlaceId(kiosk.placeId) && await deps.organizationExists(kiosk.placeId);
  return { parsed, kiosk, signatureValid, challenge, organizationKnown, now };
}

/** 検証して受理内容を返す。失敗は `{ error: <code> }` の固定語彙 (onsiteAttestationError)。 */
export async function checkVenueAttestation(token: unknown, deps: VenueAttestationDeps): Promise<AcceptedVenueAttestation> {
  const decision = decideVenueAttestation(await gatherVenueEvidence(token, deps));
  if (!decision.ok) throw onsiteAttestationError(decision.code);
  return decision.accepted;
}
