import { randomBytes, randomUUID } from 'node:crypto';
import { hashRefreshToken } from '../auth/token-hash.js';
import { verifyProjectSecret } from '../project/credentials.js';
import { AppError } from '../error.js';
import { workloadClaims } from './claims.js';
import { issueInput, introspectInput } from './input.js';
import type { WorkloadClaims, WorkloadPrincipal, WorkloadStore, WorkloadToken } from './types.js';

interface Dependencies {
  store: WorkloadStore;
  now?: () => number;
  randomToken?: () => string;
  uuid?: () => string;
  verifySecret?: (secret: string, hash: string) => Promise<boolean>;
}

/** Online-only authority. No project credential/token verifier is used here. */
export class WorkloadAuthority {
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly uuid: () => string;
  private readonly verifySecret: (secret: string, hash: string) => Promise<boolean>;
  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? Date.now;
    this.randomToken = deps.randomToken ?? (() => randomBytes(32).toString('base64url'));
    this.uuid = deps.uuid ?? randomUUID;
    this.verifySecret = deps.verifySecret ?? verifyProjectSecret;
  }

  private async authenticate(clientId: string, secret: string): Promise<WorkloadPrincipal> {
    const principal = await this.deps.store.principal(clientId);
    if (!principal || principal.revokedAt || !await this.verifySecret(secret, principal.clientSecretHash)) {
      throw AppError.unauthorized('Invalid workload credentials');
    }
    return principal;
  }

  async issue(input: unknown): Promise<{ access_token: string }> {
    const parsed = issueInput.safeParse(input);
    if (!parsed.success) throw AppError.badRequest('Invalid workload request');
    const request = parsed.data;
    const caller = await this.authenticate(request.client_id, request.client_secret);
    const state = await this.deps.store.authority(caller.id, request.audience, request.action, request.resource);
    if (!state || state.subject.clientId !== caller.clientId || state.grant.action !== request.action
      || state.grant.resource !== request.resource) throw AppError.forbidden('Workload grant unavailable');
    const now = this.now();
    const accessToken = `wk1.${this.randomToken()}`;
    const token: WorkloadToken = {
      id: this.uuid(), tokenHash: hashRefreshToken(accessToken), subject: caller.id, audience: request.audience,
      keyId: state.key.id, grantId: state.grant.id, issuedAt: new Date(now), expiresAt: new Date(now + 60000), revokedAt: null,
    };
    if (!workloadClaims({ ...state, token }, now)) throw AppError.forbidden('Workload grant unavailable');
    await this.deps.store.saveToken(token);
    return { access_token: accessToken };
  }

  async introspect(input: unknown): Promise<{ active: false } | { active: true; claims: WorkloadClaims }> {
    const parsed = introspectInput.safeParse(input);
    if (!parsed.success) throw AppError.badRequest('Invalid workload request');
    const request = parsed.data;
    const receiver = await this.authenticate(request.client_id, request.client_secret);
    if (receiver.id !== request.audience) throw AppError.unauthorized('Invalid workload credentials');
    if (!/^wk1\.[A-Za-z0-9_-]{43}$/.test(request.token)) return { active: false };
    const state = await this.deps.store.snapshot(hashRefreshToken(request.token));
    if (!state || state.target.id !== receiver.id || state.target.clientId !== receiver.clientId) return { active: false };
    const claims = workloadClaims(state, this.now());
    return claims ? { active: true, claims } : { active: false };
  }
}
