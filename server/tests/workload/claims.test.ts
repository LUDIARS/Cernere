import { describe, expect, it } from 'vitest';
import { workloadClaims } from '../../src/workload/claims.js';
import { snapshot, now, publicKeyPem } from './fixture.js';

describe('C-14 workloadClaims', () => {
  it('returns Ex-compatible claims bound to the registered proof key and grant', () => {
    expect(workloadClaims(snapshot(), now)).toEqual({
      kind: 'workload', sub: 'site-a/excubitor', aud: 'site-b/excubitor',
      iat: '2026-10-07T00:00:00.000Z', exp: '2026-10-07T00:01:00.000Z',
      jti: snapshot().token.id, cnf: { public_key: publicKeyPem },
      grants: [{ action: 'vault', resource: 'service:concordia', keys: ['KEY_A'] }],
    });
  });
  it.each(['subject', 'target', 'key', 'targetKey', 'grant', 'token'] as const)('honors %s revocation', field => {
    const state = snapshot(); state[field].revokedAt = new Date(now);
    expect(workloadClaims(state, now)).toBeNull();
  });
  it.each([
    [now + 1, now + 60000], [now, now], [now, now + 60001], [NaN, now + 60000],
  ])('rejects invalid issue/expiry bounds %s %s', (issued, expires) => {
    const state = snapshot(); state.token.issuedAt = new Date(issued); state.token.expiresAt = new Date(expires);
    expect(workloadClaims(state, now)).toBeNull();
  });
  it('expires exactly at exp', () => expect(workloadClaims(snapshot(), now + 60000)).toBeNull());
  it.each(['subject', 'audience', 'keyId', 'grantId'] as const)('rejects %s substitution', field => {
    const state = snapshot(); state.token[field] = 'substituted';
    expect(workloadClaims(state, now)).toBeNull();
  });
  it('does not allow empty vault keys', () => {
    const state = snapshot(); state.grant.keys = [];
    expect(workloadClaims(state, now)).toBeNull();
  });
});
