import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { WorkloadAuthority } from '../../src/workload/authority.js';
import { hashRefreshToken } from '../../src/auth/token-hash.js';
import { snapshot, now, clientA, clientB } from './fixture.js';
import type { WorkloadStore, WorkloadToken } from '../../src/workload/types.js';

function setup() {
  const state = snapshot();
  const dummySecret = randomBytes(32).toString('base64url');
  const store: WorkloadStore = {
    principal: vi.fn(async id => id === clientA ? state.subject : id === clientB ? state.target : null),
    authority: vi.fn(async () => state), saveToken: vi.fn(async (token: WorkloadToken) => { state.token = token; }),
    snapshot: vi.fn(async hash => state.token.tokenHash === hash ? state : null),
  };
  const verifySecret = vi.fn(async (secret: string, hash: string) => secret === dummySecret && !!hash);
  const authority = new WorkloadAuthority({ store, now: () => now, randomToken: () => 'a'.repeat(43), uuid: () => state.token.id, verifySecret });
  const issue = { client_id: clientA, client_secret: dummySecret, audience: state.target.id, action: 'vault', resource: 'service:concordia' };
  const introspect = { client_id: clientB, client_secret: dummySecret, audience: state.target.id, token: `wk1.${'a'.repeat(43)}` };
  return { state, store, verifySecret, authority, issue, introspect };
}

describe('online workload authority', () => {
  it('stores only a token hash and rechecks every introspection', async () => {
    const f = setup(); const issued = await f.authority.issue(f.issue);
    expect(f.state.token.tokenHash).toBe(hashRefreshToken(issued.access_token));
    expect(JSON.stringify(f.state.token)).not.toContain(issued.access_token);
    expect(await f.authority.introspect(f.introspect)).toMatchObject({ active: true, claims: { kind: 'workload' } });
    f.state.grant.revokedAt = new Date(now);
    expect(await f.authority.introspect(f.introspect)).toEqual({ active: false });
    expect(f.store.snapshot).toHaveBeenCalledTimes(2);
  });
  it.each(['subject', 'target', 'key', 'targetKey', 'grant', 'token'] as const)('rejects %s revoked after issue', async field => {
    const f = setup(); await f.authority.issue(f.issue); f.state[field].revokedAt = new Date(now);
    if (field === 'target') await expect(f.authority.introspect(f.introspect)).rejects.toMatchObject({ statusCode: 401 });
    else expect(await f.authority.introspect(f.introspect)).toEqual({ active: false });
  });
  it('authenticates target, not sender credentials, for introspection', async () => {
    const f = setup(); await f.authority.issue(f.issue);
    await expect(f.authority.introspect({ ...f.introspect, client_id: clientA })).rejects.toMatchObject({ statusCode: 401 });
  });
  it('fails closed on missing/incorrect grant without saving a token', async () => {
    const f = setup(); f.state.grant.resource = 'service:other';
    await expect(f.authority.issue(f.issue)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.store.saveToken).not.toHaveBeenCalled();
  });
  it('never accepts service tokens or unknown opaque tokens', async () => {
    const f = setup();
    const dummyServiceToken = `v4.public.${randomBytes(64).toString('base64url')}`;
    expect(await f.authority.introspect({ ...f.introspect, token: dummyServiceToken })).toEqual({ active: false });
    expect(await f.authority.introspect(f.introspect)).toEqual({ active: false });
  });
  it('requires an independently registered workload credential', async () => {
    const f = setup();
    await expect(f.authority.issue({ ...f.issue, client_id: '10000000-0000-4000-8000-000000000099' })).rejects.toMatchObject({ statusCode: 401 });
    await expect(f.authority.issue({ ...f.issue, client_secret: randomBytes(32).toString('base64url') })).rejects.toMatchObject({ statusCode: 401 });
  });
});
