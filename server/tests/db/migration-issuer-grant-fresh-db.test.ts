import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// aedilis / bibliotheca の managed project は migration では作られない (本番 DB にだけある)。
// 新しい DB で外部キー違反により migration 全体が止まらないよう、その grant は対象 project の存在を条件にする。
const read = (file: string): string =>
  readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8');

describe.each([
  ['046_aedilis_issuer_grant.sql', 'aedilis'],
  ['056_bibliotheca_issuer_grant.sql', 'bibliotheca'],
])('%s on a fresh database', (file, target) => {
  const sql = read(file);

  it('inserts the grant only when both managed projects exist', () => {
    expect(sql).toContain(`SELECT '${target}', 'excubitor', TRUE`);
    expect(sql).toContain(`WHERE EXISTS (SELECT 1 FROM managed_projects WHERE key = '${target}')`);
    expect(sql).toContain("EXISTS (SELECT 1 FROM managed_projects WHERE key = 'excubitor')");
    expect(sql).not.toContain(`VALUES ('${target}'`);
  });

  it('keeps the idempotent upsert', () => {
    expect(sql).toMatch(/ON CONFLICT \(target_project_key, issuer_project_key\) DO UPDATE SET/);
  });
});
