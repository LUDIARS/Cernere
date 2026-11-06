/** C-41: outside_venue (and unknown values) are shown as an exception with reject as the default; venue and legacy rows are not. */
type View = { registrationOrigin: string | null; exception: boolean; defaultDecision: string | null };

export default {
  post(result: View, value: unknown): true | string {
    if (value === null || value === undefined) return (!result.exception && result.registrationOrigin === null && result.defaultDecision === null) || 'legacy registration must keep the old review';
    if (value === 'venue') return (!result.exception && result.registrationOrigin === 'venue' && result.defaultDecision === null) || 'venue registration is not an exception';
    return (result.exception && result.registrationOrigin === 'outside_venue' && result.defaultDecision === 'reject') || 'outside_venue must be an exception rejected by default';
  },
};
