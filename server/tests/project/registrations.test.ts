import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const { execute, limit, where } = vi.hoisted(() => ({ execute: vi.fn(), limit: vi.fn(), where: vi.fn() }));
vi.mock('../../src/db/connection.js', () => ({ db: {
  select: () => ({ from: () => ({ where }) }), execute,
} }));
const { listProjectRegistrations } = await import('../../src/project/registrations.js');
beforeEach(() => {
  vi.clearAllMocks();
  where.mockReturnValue({ limit });
  limit.mockResolvedValue([{ storageSlug: 'glab' }]);
  execute.mockResolvedValue([]);
});
it('rejects caller-selected projects and invalid cursors before accessing storage', async () => {
  await expect(listProjectRegistrations('glab', { targetProjectKey: 'other' })).rejects.toThrow('Invalid registration cursor');
  await expect(listProjectRegistrations('glab', { after: "'; DROP TABLE users;" })).rejects.toThrow('Invalid registration cursor');
  expect(where).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});
it('uses the authenticated project and a bounded profile-free projection', async () => {
  await listProjectRegistrations('glab', {});
  const dialect = new PgDialect();
  expect(dialect.sqlToQuery(where.mock.calls[0]![0]).params).toContain('glab');
  const query = dialect.sqlToQuery(execute.mock.calls[0]![0]);
  expect(query.sql).toContain('"project_data_glab"');
  expect(query.sql).toContain('LIMIT 101');
  expect(query.sql).not.toContain('SELECT *');
});
it('does not expose a missing or inactive project', async () => {
  limit.mockResolvedValue([]);
  await expect(listProjectRegistrations('glab', {})).rejects.toThrow('Project not found');
  expect(execute).not.toHaveBeenCalled();
});
