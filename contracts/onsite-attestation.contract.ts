// C-9: an accepted onsite attestation is an mfa-purpose, fresh, subject-bound proof at an allowed place.
type Satisfaction = {
  readonly userId: string; readonly method: string; readonly assurance: string;
  readonly placeId: string; readonly lanId: string; readonly issuedAt: number; readonly acceptedAt: number;
};
const ACCEPTED = new Set(['high', 'medium']);
const REJECTED_METHODS = new Set(['staff_override', 'session', 'password']);
const FRESHNESS_MS = 120_000;

export default {
  post: (result: { readonly satisfaction: Satisfaction; readonly requirement: { readonly minAssurance: string; readonly allowedPlaceIds: readonly string[] | null } }): true | string => {
    const { satisfaction: s, requirement: r } = result;
    if (REJECTED_METHODS.has(s.method) || !ACCEPTED.has(s.assurance)) return 'manual / low assurance must never satisfy onsite MFA';
    if (r.minAssurance === 'high' && s.assurance !== 'high') return 'high requirement accepts only high assurance';
    if (Math.abs(s.acceptedAt - s.issuedAt) > FRESHNESS_MS) return 'attestation must be within 120 seconds';
    if (r.allowedPlaceIds && !r.allowedPlaceIds.includes(s.placeId)) return 'placeId must be an allowed place';
    return Boolean(s.userId && s.lanId) || 'subject and kiosk must be recorded';
  },
};
