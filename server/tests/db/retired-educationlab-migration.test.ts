import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isIgnorableMigrationError, splitStatements } from '../../src/db/migration-files.js';

const sql = readFileSync(new URL('../../../migrations/077_remove_retired_educationlab.sql', import.meta.url), 'utf8');

describe('retired EducationLab removal: migration runner boundary', () => {
  it('executes the guarded cleanup as one atomic statement', () => {
    const statements = splitStatements(sql).filter(statement => statement.trim());
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("ERRCODE = 'P0001'");
    expect(isIgnorableMigrationError('P0001')).toBe(false);
  });
});
