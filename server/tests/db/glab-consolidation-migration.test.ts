import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isIgnorableMigrationError, splitStatements } from '../../src/db/migration-files.js';

const sql = readFileSync(new URL('../../../migrations/075_consolidate_glab_registration.sql', import.meta.url), 'utf8');

describe('GLab consolidation migration runner boundary', () => {
  it('preserves the atomic DO block instead of applying its writes separately', () => {
    const statements = splitStatements(sql).filter(statement => statement.trim());
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("ERRCODE = 'P0001'");
    expect(isIgnorableMigrationError('P0001')).toBe(false);
  });
});
