import type { WorkloadClaims, WorkloadSnapshot } from './types.js';
import { contract } from '@ludiars/log-weaver';
import claimsContract from './contracts/claims.contract.js';

function deriveWorkloadClaims(snapshot: WorkloadSnapshot, now: number): WorkloadClaims | null {
  const { subject, target, key, targetKey, grant, token } = snapshot;
  if ([subject, target, key, targetKey, grant, token].some(row => row.revokedAt !== null)) return null;
  const iat = token.issuedAt.getTime();
  const exp = token.expiresAt.getTime();
  if (!Number.isFinite(now) || !Number.isFinite(iat) || !Number.isFinite(exp)
    || iat > now || exp <= now || exp <= iat || exp - iat > 60000) return null;
  if (token.subject !== subject.id || token.audience !== target.id
    || token.keyId !== key.id || key.subject !== subject.id || targetKey.subject !== target.id
    || token.grantId !== grant.id || grant.subject !== subject.id || grant.audience !== target.id) return null;
  if (grant.action === 'vault' && !grant.keys?.length) return null;
  return {
    kind: 'workload', sub: subject.id, aud: target.id, iat: token.issuedAt.toISOString(),
    exp: token.expiresAt.toISOString(), jti: token.id, cnf: { public_key: key.publicKeyPem },
    grants: [{ action: grant.action, resource: grant.resource,
      ...(grant.action === 'vault' ? { keys: [...(grant.keys ?? [])] } : {}) }],
  };
}

export const workloadClaims = contract(deriveWorkloadClaims, {
  ...claimsContract, contractId: 'C-14', mode: 'observe', sample: 1,
  where: 'server/src/workload/claims.ts', rule: 'contract-wrap', id: 'workload-claims',
});
