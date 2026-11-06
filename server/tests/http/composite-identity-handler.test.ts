import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ values: new Map<string, string>(), revoked: false, consent: true, allowed: true,
  risk: 'sensitive_read', where: vi.fn(), query: vi.fn(), create: vi.fn(), status: vi.fn(), revoke: vi.fn() }));
vi.mock('../../src/logging/auth-logger.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../../src/logging/face-audit.js', () => ({ recordFaceAudit: vi.fn() }));
vi.mock('../../src/identity/face-consent-store.js', () => ({ createFaceConsent: state.create, listOwnFaceConsents: state.status, revokeFaceConsents: state.revoke }));
vi.mock('../../src/db/connection.js', () => ({ db: { select: () => ({ from: () => ({ innerJoin: () => ({
  where: (predicate: unknown) => { state.where(predicate); return { limit: state.query }; },
}) }) }) } }));
vi.mock('drizzle-orm', async importOriginal => ({ ...await importOriginal<typeof import('drizzle-orm')>(),
  eq: (_column: unknown, value: unknown) => ({ value }),
}));
const actions = ['identity.organizations.read', 'identity.face-consent.read', 'identity.face-consent.create', 'identity.face-consent.revoke'];
vi.mock('../../src/auth/composite-session.js', () => ({
  compositeSessionStore: { bind: vi.fn(), revoke: vi.fn() },
  currentCompositeSession: async () => {
    if (state.revoked) throw new Error('Session revoked');
    return { project: { key: 'glab', schemaDefinition: { service_operations: actions.map(action => ({ action,
      risk: action.endsWith('.read') ? state.risk : 'important', permissions: [`service_operation.${action}`] })) } },
      grant: { source: { sub: 'native-account' } }, grantId: 'grant', identity: { subject: 'service-subject' },
      consent: state.consent ? { granted: actions.map(action => `service_operation.${action}`) } : null,
      permissions: actions.map(action => ({ key: `service_operation.${action}`, allowed: state.allowed })), expiresAt: Date.now() + 600_000 };
  },
}));
vi.mock('../../src/redis.js', () => ({ checkRateLimit: async () => {}, redis: {
  set: async (key: string, value: string, ...options: unknown[]) => {
    if (options.includes('NX') && state.values.has(key)) return null;
    state.values.set(key, value); return 'OK';
  },
  getdel: async (key: string) => { const value = state.values.get(key) ?? null; state.values.delete(key); return value; },
} }));
const { handleCompositeServiceRoute } = await import('../../src/http/composite-service-handler.js');
const auth = 'Bearer current-project-credential';
const base = { projectToken: 'scoped-project-token', sessionBinding: 's'.repeat(43), requestId: '11111111-1111-4111-8111-111111111111' };
async function issue(action = 'identity.organizations.read', resource = 'self:organizations', payload = '{}') {
  const result = await handleCompositeServiceRoute('authorize', JSON.stringify({ ...base, action, resource,
    contentDigest: createHash('sha256').update(payload).digest('base64url') }), auth);
  return { ...base, payload, permit: (result.data as { permit: string }).permit };
}
const call = (route: string, value: object) => handleCompositeServiceRoute(route, JSON.stringify(value), auth);
beforeEach(() => {
  vi.clearAllMocks(); state.values.clear(); state.revoked = false; state.consent = true; state.allowed = true; state.risk = 'sensitive_read';
  state.query.mockResolvedValue([{ id: 'organization', name: 'Own organization', role: 'owner' }]);
  state.status.mockResolvedValue({ items: [] }); state.revoke.mockResolvedValue({ ok: true, revoked: 1, facilities: [] });
  state.create.mockResolvedValue({ consentId: 'consent', at: new Date().toISOString() });
});

describe('scoped own identity operations', () => {
  it('queries only the native grant owner, never the service subject or supplied user', async () => {
    const input = await issue();
    const result = await call('identity-organizations', input);
    expect(result.data).toMatchObject({ requestId: base.requestId, risk: 'sensitive_read', data: { items: expect.any(Array) } });
    expect(state.where).toHaveBeenCalledWith({ value: 'native-account' });
    await expect(call('identity-organizations', input)).rejects.toThrow();
    expect(state.query).toHaveBeenCalledOnce();
  });
  it('permits only one parallel execution', async () => {
    const input = await issue();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => call('identity-organizations', input)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(state.query).toHaveBeenCalledOnce();
  });
  it.each(['revoked', 'allowed', 'consent', 'risk'])('denies current %s changes before reading a resource', async field => {
    const input = await issue();
    if (field === 'revoked') state.revoked = true;
    else if (field === 'risk') state.risk = 'read';
    else state[field as 'allowed' | 'consent'] = false;
    await expect(call('identity-organizations', input)).rejects.toThrow();
    expect(state.query).not.toHaveBeenCalled();
  });
  it.each([{ userId: 'other' }, { module: 'member' }, { facilityId: 'other' }, { photo: 'bytes' }])('rejects extra own-identity payload %j', async payload => {
    const input = await issue();
    await expect(call('identity-organizations', { ...input, payload: JSON.stringify(payload) })).rejects.toThrow();
    expect(state.query).not.toHaveBeenCalled();
  });
  it('binds consent creation to the exact facility and policy bytes', async () => {
    const facilityId = '22222222-2222-4222-8222-222222222222';
    const payload = JSON.stringify({ facilityId, policyVersion: 'current' });
    const input = await issue('identity.face-consent.create', 'self:face-consent', payload);
    await expect(call('identity-face-consent-create', { ...input, payload: JSON.stringify({ facilityId, policyVersion: 'changed' }) })).rejects.toThrow();
    expect(state.create).not.toHaveBeenCalled();
  });
  it('retains the existing consent mutation store and native account checks', async () => {
    const facilityId = '22222222-2222-4222-8222-222222222222';
    const payload = JSON.stringify({ facilityId, policyVersion: 'current' });
    const input = await issue('identity.face-consent.create', 'self:face-consent', payload);
    await call('identity-face-consent-create', input);
    expect(state.create).toHaveBeenCalledExactlyOnceWith('native-account', 'current', facilityId);
  });
  it('rejects global identity and biometric route names', async () => {
    await expect(call('identity-face-photo', await issue())).rejects.toThrow();
    expect(state.query).not.toHaveBeenCalled(); expect(state.create).not.toHaveBeenCalled();
  });
});
