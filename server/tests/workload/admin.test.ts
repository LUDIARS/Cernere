import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb } from '../identity/fake-drizzle.js';
import { publicKeyPem } from './fixture.js';

const fake = createFakeDb();
vi.mock('../../src/db/connection.js', () => ({ db: fake.db }));
vi.mock('../../src/project/credentials.js', () => ({ hashProjectSecret: vi.fn(async () => 'hashed-secret') }));
const session = vi.fn(async () => ({ userId: 'admin' }));
const state = vi.fn(async (): Promise<{ state: string } | null> => ({ state: 'logged_in' }));
vi.mock('../../src/redis.js', () => ({ getSession: session, getUserState: state }));
const { dispatch } = await import('../../src/commands.js');
const { workloadAdminCommand } = await import('../../src/workload/admin-command.js');
const { workloadPrincipals, workloadKeys, operationLogs } = await import('../../src/db/schema.js');

describe('workload administrator enrollment', () => {
  beforeEach(() => {
    fake.inserts.length = 0; fake.updates.length = 0;
    session.mockResolvedValue({ userId: 'admin' }); state.mockResolvedValue({ state: 'logged_in' });
  });
  it.each([
    ['register', { id: 'site-a/excubitor', publicKeyPem }],
    ['grant', { subject: 'site-a/excubitor', audience: 'site-b/excubitor', action: 'hq-config', resource: 'service:concordia' }],
    ['revoke_principal', { id: 'site-a/excubitor' }],
    ['revoke_key', { id: '10000000-0000-4000-8000-000000000001' }],
    ['revoke_grant', { id: '10000000-0000-4000-8000-000000000001' }],
    ['revoke_token', { id: '10000000-0000-4000-8000-000000000001' }],
  ])('rejects %s with missing or expired state before any workload write', async (action, payload) => {
    for (const [current, statusCode] of [[null, 401], [{ state: 'session_expired' }, 403]] as const) {
      fake.inserts.length = 0; fake.updates.length = 0;
      state.mockResolvedValue(current);
      await expect(dispatch('admin', 'session', 'workload_authority', action as string, payload))
        .rejects.toMatchObject({ statusCode });
      expect(fake.inserts.every(row => row.table === operationLogs)).toBe(true);
      expect(fake.updates).toEqual([]);
    }
  });
  it('requires an active user session before any enrollment', async () => {
    session.mockResolvedValue({ userId: 'other' });
    await expect(dispatch('admin', 'session', 'workload_authority', 'register', {})).rejects.toMatchObject({ statusCode: 401 });
    expect(fake.inserts.every(row => row.table === operationLogs)).toBe(true);
  });
  it('rejects non-admin users', async () => {
    fake.queueSelect([{ role: 'general' }]);
    await expect(dispatch('admin', 'session', 'workload_authority', 'register', {})).rejects.toMatchObject({ statusCode: 403 });
    expect(fake.inserts.every(row => row.table === operationLogs)).toBe(true);
  });
  it('stores only a hash and registered public key, redacts admin audit input', async () => {
    fake.queueSelect([{ role: 'admin' }]);
    const result = await dispatch('admin', 'session', 'workload_authority', 'register', {
      id: 'site-a/excubitor', publicKeyPem,
    }) as { client_secret: string; client_id: string };
    expect(result.client_secret).toHaveLength(43);
    const principal = fake.inserts.find(row => row.table === workloadPrincipals)?.values;
    expect(principal).toMatchObject({ id: 'site-a/excubitor', clientId: result.client_id, clientSecretHash: 'hashed-secret' });
    expect(JSON.stringify(principal)).not.toContain(result.client_secret);
    expect(fake.inserts.find(row => row.table === workloadKeys)?.values).toMatchObject({ publicKeyPem });
    expect(fake.inserts.find(row => row.table === operationLogs)?.values).toMatchObject({ params: { redacted: true } });
  });
  it('does not expose raw database errors', async () => {
    const transaction = fake.db.transaction as ReturnType<typeof vi.fn>;
    transaction.mockRejectedValueOnce(new Error('SQL with secret material'));
    await expect(workloadAdminCommand('register', { id: 'site-a/excubitor', publicKeyPem })).rejects.toThrow('Workload management unavailable');
  });
  it('provides no re-enable or client-defined secret action', async () => {
    await expect(workloadAdminCommand('enable', { id: 'site-a/excubitor' })).rejects.toMatchObject({ statusCode: 400 });
  });
});
