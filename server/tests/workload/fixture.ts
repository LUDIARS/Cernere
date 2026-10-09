/** @implements SPEC-WORKLOAD-AUTHORITY: synthetic registration/grant/60-second snapshot fixtures. */
import type { WorkloadSnapshot } from '../../src/workload/types.js';

// RFC 8032 public test vector; no real enrollment or private material.
export const publicKeyPem = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=\n-----END PUBLIC KEY-----\n';
export const clientA = '10000000-0000-4000-8000-000000000001';
export const clientB = '10000000-0000-4000-8000-000000000002';
export const now = Date.parse('2026-10-07T00:00:00.000Z');
export function snapshot(): WorkloadSnapshot {
  return {
    subject: { id: 'site-a/excubitor', clientId: clientA, clientSecretHash: 'caller-hash', revokedAt: null },
    target: { id: 'site-b/excubitor', clientId: clientB, clientSecretHash: 'receiver-hash', revokedAt: null },
    key: { id: '10000000-0000-4000-8000-000000000003', subject: 'site-a/excubitor', publicKeyPem, revokedAt: null },
    targetKey: { id: '10000000-0000-4000-8000-000000000004', subject: 'site-b/excubitor', publicKeyPem, revokedAt: null },
    grant: { id: '10000000-0000-4000-8000-000000000005', subject: 'site-a/excubitor', audience: 'site-b/excubitor',
      action: 'vault', resource: 'service:concordia', keys: ['KEY_A'], revokedAt: null },
    token: { id: '10000000-0000-4000-8000-000000000006', tokenHash: 'hash', subject: 'site-a/excubitor',
      audience: 'site-b/excubitor', keyId: '10000000-0000-4000-8000-000000000003',
      grantId: '10000000-0000-4000-8000-000000000005', issuedAt: new Date(now), expiresAt: new Date(now + 60000), revokedAt: null },
  };
}
