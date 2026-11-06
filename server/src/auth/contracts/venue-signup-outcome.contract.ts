/** C-40: signup joins an organization only through a verified, unconsumed, unexpired challenge; an invalid one never falls back to outside_venue. */
type Row = { id: string; expiresAt: Date; verifiedAt: Date | null; placeId: string | null; consumedAt: Date | null } | null;
type Outcome = { kind: 'venue'; challengeId: string; placeId: string } | { kind: 'outside_venue' } | { kind: 'invalid' };

export default {
  post(result: Outcome, venueChallengeId: string | undefined, row: Row, now: Date): true | string {
    if (venueChallengeId === undefined) return result.kind === 'outside_venue' || 'no challenge must register outside_venue';
    if (result.kind === 'outside_venue') return 'a specified challenge must never fall back to outside_venue';
    const usable = row !== null && row.id === venueChallengeId && row.verifiedAt !== null && row.consumedAt === null
      && row.expiresAt.getTime() > now.getTime() && Boolean(row.placeId);
    if (!usable) return result.kind === 'invalid' || 'unverified, consumed or expired challenge must be invalid';
    return (result.kind === 'venue' && result.placeId === row.placeId && result.challengeId === row.id) || 'usable challenge must join its place';
  },
};
