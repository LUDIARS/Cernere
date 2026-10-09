import { z } from 'zod';
import { normalizeEd25519PublicKeyPem } from '../auth/onsite-kiosk-input.js';
import { AppError } from '../error.js';
import { contract } from '@ludiars/log-weaver';
import registrationContract from './contracts/registration.contract.js';
import grantContract from './contracts/grant.contract.js';

export const workloadId = z.string().max(128).regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/);
const registration = z.object({ id: workloadId, publicKeyPem: z.string().max(4096) }).strict();
const grant = z.object({
  subject: workloadId, audience: workloadId,
  action: z.string().min(1).max(128), resource: z.string().min(1).max(256),
  keys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128)).min(1).max(128).optional(),
}).strict();
export type WorkloadRegistration = z.infer<typeof registration>;
export type WorkloadGrantInput = z.infer<typeof grant>;

function validateWorkloadRegistration(input: unknown): WorkloadRegistration {
  const parsed = registration.safeParse(input);
  if (!parsed.success) throw AppError.badRequest('Invalid workload registration');
  // createPublicKey also accepts private keys: require public SPKI framing before normalization.
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\s*$/.test(parsed.data.publicKeyPem)) {
    throw AppError.badRequest('An Ed25519 SPKI public key is required');
  }
  return { ...parsed.data, publicKeyPem: normalizeEd25519PublicKeyPem(parsed.data.publicKeyPem) };
}

function validateWorkloadGrant(input: unknown): WorkloadGrantInput {
  const parsed = grant.safeParse(input);
  if (!parsed.success) throw AppError.badRequest('Invalid workload grant');
  const value = parsed.data;
  const service = /^service:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.resource);
  const permitted = (value.action === 'monitor' && value.resource === `node:${value.audience}`)
    || (/^operation:(update|restart|deploy|reflect|start|stop|bootstrap|data-export|data-import)$/.test(value.action) && service)
    || (value.action === 'hq-config' && value.resource === 'service:concordia')
    || ((value.action === 'ai-spawn' || value.action === 'ai-inject') && /^thread:[0-9]{1,20}:[0-9]{1,20}$/.test(value.resource))
    || (value.action === 'vault' && service)
    || (value.action === 'bundle' && /^repository:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value.resource));
  if (!permitted || (value.action === 'vault' ? !value.keys?.length : value.keys !== undefined)) {
    throw AppError.badRequest('Invalid workload grant');
  }
  return { ...value, ...(value.keys ? { keys: [...new Set(value.keys)].sort() } : {}) };
}

export const parseWorkloadRegistration = contract(validateWorkloadRegistration, {
  ...registrationContract, contractId: 'C-15', mode: 'observe', sample: 1,
  where: 'server/src/workload/input.ts', rule: 'contract-wrap', id: 'workload-registration',
});
export const parseWorkloadGrant = contract(validateWorkloadGrant, {
  ...grantContract, contractId: 'C-16', mode: 'observe', sample: 1,
  where: 'server/src/workload/input.ts', rule: 'contract-wrap', id: 'workload-grant',
});

const credentials = { client_id: z.string().uuid(), client_secret: z.string().min(32).max(72), audience: workloadId };
export const issueInput = z.object({ ...credentials, action: z.string().min(1).max(128), resource: z.string().min(1).max(256) }).strict();
export const introspectInput = z.object({ ...credentials, token: z.string().min(1).max(8192) }).strict();
export type IssueInput = z.infer<typeof issueInput>;
export type IntrospectInput = z.infer<typeof introspectInput>;
