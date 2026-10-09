import type { WorkloadClaims, WorkloadSnapshot } from '../types.js';

export default {
  post: (result: WorkloadClaims | null, state: WorkloadSnapshot, now: number): true | string => {
    const { token, subject, target, key, targetKey, grant } = state;
    const issued = token.issuedAt.getTime();
    const expires = token.expiresAt.getTime();
    const eligible = [subject, target, key, targetKey, grant, token].every(row => row.revokedAt === null)
      && [now, issued, expires].every(Number.isFinite) && issued <= now && now < expires
      && expires - issued > 0 && expires - issued <= 60000
      && token.subject === subject.id && token.audience === target.id
      && token.keyId === key.id && key.subject === subject.id && targetKey.subject === target.id
      && token.grantId === grant.id && grant.subject === subject.id && grant.audience === target.id
      && (grant.action !== 'vault' || !!grant.keys?.length);
    if (!eligible) return result === null || 'revoked, mismatched or expired authority was accepted';
    if (!result) return 'valid workload authority unexpectedly rejected';
    return (result.kind === 'workload' && result.sub === subject.id && result.aud === target.id
      && result.iat === token.issuedAt.toISOString() && result.exp === token.expiresAt.toISOString()
      && result.jti === token.id && result.cnf.public_key === key.publicKeyPem
      && result.grants.length === 1 && result.grants[0].action === grant.action
      && result.grants[0].resource === grant.resource
      && JSON.stringify(result.grants[0].keys) === JSON.stringify(grant.action === 'vault' ? grant.keys : undefined))
      || 'claims diverge from the registered authority';
  },
};
