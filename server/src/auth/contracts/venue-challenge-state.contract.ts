/** C-39: the polled state never exposes place data and is verified only for an unconsumed, unexpired, verified challenge. */
type Row = { id: string; expiresAt: Date; verifiedAt: Date | null; placeId: string | null; consumedAt: Date | null } | null;

export default {
  post(result: string, row: Row, now: Date): true | string {
    if (result !== 'pending' && result !== 'verified' && result !== 'expired') return 'state must be pending, verified or expired';
    const live = row !== null && row.consumedAt === null && row.expiresAt.getTime() > now.getTime();
    if (!live) return result === 'expired' || 'consumed, expired or unknown challenge must read as expired';
    return result === (row.verifiedAt ? 'verified' : 'pending') || 'live challenge must reflect verification';
  },
};
