import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dryRunMigrations, findNonTransactional, type PendingMigration } from '../../src/db/migration-dry-run.js';
import { splitStatements } from '../../src/db/migration-files.js';

/** 実 DB を使わず、発行された SQL を記録する専用接続の代役。 */
function recorder(failures: Record<string, { code?: string; message: string }> = {}) {
  const calls: string[] = [];
  return {
    calls,
    db: {
      async unsafe(statement: string) {
        calls.push(statement);
        const failure = failures[statement];
        if (failure) throw Object.assign(new Error(failure.message), { code: failure.code });
        return [];
      },
    },
  };
}

const pending: PendingMigration[] = [
  { version: '900_a', statements: ['CREATE TABLE IF NOT EXISTS a (id INT)', 'CREATE INDEX IF NOT EXISTS a_id ON a(id)'] },
  { version: '901_b', statements: ['ALTER TABLE a ADD COLUMN IF NOT EXISTS b TEXT'] },
];

describe('migration dry-run', () => {
  it('applies pending statements inside one transaction and always rolls back', async () => {
    const r = recorder();
    const result = await dryRunMigrations(r.db, pending);
    expect(result).toMatchObject({ outcome: 'ok', checked: ['900_a', '901_b'], rolledBack: true, committed: false });
    expect(r.calls[0]).toBe('BEGIN');
    expect(r.calls.at(-1)).toBe('ROLLBACK');
    expect(r.calls.filter(c => c === 'BEGIN')).toHaveLength(1);
    expect(r.calls.some(c => /^COMMIT\b/i.test(c))).toBe(false);
    expect(r.calls.some(c => /_migrations/.test(c))).toBe(false);
    expect(r.calls).toContain('ALTER TABLE a ADD COLUMN IF NOT EXISTS b TEXT');
  });

  it('stops at the first failing migration, reports it and still rolls back', async () => {
    const r = recorder({ 'CREATE INDEX IF NOT EXISTS a_id ON a(id)': { code: '42703', message: 'column "id" does not exist' } });
    const result = await dryRunMigrations(r.db, pending);
    expect(result.outcome).toBe('failed');
    expect(result.failure).toMatchObject({ version: '900_a', code: '42703' });
    expect(result.checked).toEqual([]);
    expect(r.calls).not.toContain('ALTER TABLE a ADD COLUMN IF NOT EXISTS b TEXT');
    expect(r.calls.at(-1)).toBe('ROLLBACK');
    expect(result.rolledBack).toBe(true);
  });

  it('skips idempotent duplicate errors through a savepoint like runMigrations', async () => {
    const r = recorder({ 'CREATE TABLE IF NOT EXISTS a (id INT)': { code: '42P07', message: 'relation "a" already exists' } });
    const result = await dryRunMigrations(r.db, pending);
    expect(result.outcome).toBe('ok');
    expect(result.skipped).toEqual([{ version: '900_a', code: '42P07', statement: 'CREATE TABLE IF NOT EXISTS a (id INT)' }]);
    expect(r.calls).toContain('ROLLBACK TO SAVEPOINT cernere_migration_dry_run');
    expect(r.calls.at(-1)).toBe('ROLLBACK');
  });

  it('rolls back even when the connection fails unexpectedly mid-transaction', async () => {
    const r = recorder({ 'SAVEPOINT cernere_migration_dry_run': { message: 'connection reset' } });
    await expect(dryRunMigrations(r.db, pending)).rejects.toThrow('connection reset');
    expect(r.calls.at(-1)).toBe('ROLLBACK');
  });

  it('refuses to start when a migration cannot run inside a transaction', async () => {
    const r = recorder();
    const result = await dryRunMigrations(r.db, [
      ...pending,
      { version: '902_c', statements: ['CREATE INDEX CONCURRENTLY IF NOT EXISTS a_b ON a(b)'] },
    ]);
    expect(result.outcome).toBe('blocked');
    expect(result.blocked).toEqual([expect.objectContaining({ version: '902_c', reason: 'CONCURRENTLY' })]);
    expect(r.calls).toEqual([]);
  });

  it('detects other non-transactional statements', () => {
    const blocked = findNonTransactional([{ version: 'x', statements: [
      'COMMIT', 'VACUUM a', "ALTER TYPE mood ADD VALUE 'ok'", 'CREATE DATABASE other', 'DROP INDEX CONCURRENTLY a_b',
      'REINDEX TABLE CONCURRENTLY a', 'CREATE TABLE ok (id INT)',
    ] }]);
    expect(blocked).toHaveLength(6);
  });

  it('accepts every repository migration as transactional (including 061 workload authority)', () => {
    const dir = new URL('../../../migrations/', import.meta.url);
    const all = readdirSync(dir).filter(f => f.endsWith('.sql')).map(file => ({
      version: file.replace('.sql', ''),
      statements: splitStatements(readFileSync(new URL(file, dir), 'utf8')),
    }));
    expect(all.some(m => m.version === '061_workload_authority')).toBe(true);
    expect(findNonTransactional(all)).toEqual([]);
  });
});
