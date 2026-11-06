/** C-38: only a kiosk-signed, registration-purpose, subject-less, fresh, network attestation at the kiosk's organization is accepted. */
type Evidence = {
  parsed: { payload: { sub: string | null; placeId: string; lanId: string; nonce: string; issuedAt: number; method?: string; assurance?: string; purpose?: string } };
  kiosk: { lanId: string; placeId: string; status: string } | null;
  signatureValid: boolean;
  challenge: { state: string; challengeId?: string } | null;
  organizationKnown: boolean;
  now: number;
};
type Decision = { ok: true; accepted: { challengeId: string; placeId: string; lanId: string; issuedAt: number; acceptedAt: number } } | { ok: false; code: string };

export default {
  post(result: Decision, evidence: Evidence): true | string {
    if (!result.ok) return true;
    const p = evidence.parsed.payload;
    const k = evidence.kiosk;
    if (!k || k.status !== 'active' || !evidence.signatureValid) return 'accepted without an active kiosk signature';
    if (p.purpose !== 'registration') return 'accepted a non-registration purpose';
    if (evidence.challenge?.state !== 'active' || result.accepted.challengeId !== evidence.challenge.challengeId) return 'accepted without a live challenge';
    if (p.sub !== null) return 'accepted an attestation with a subject';
    if (Math.abs(evidence.now - p.issuedAt) > 120_000) return 'accepted a stale attestation';
    if (p.method !== 'lan' || p.assurance !== 'network') return 'accepted a non-network assurance';
    if (p.placeId !== k.placeId || result.accepted.placeId !== k.placeId) return 'organization must come from the registered kiosk';
    return evidence.organizationKnown || 'accepted an unknown organization';
  },
};
