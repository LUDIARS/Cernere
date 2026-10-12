import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// aedilis の managed project は migration では作られない (本番 DB にだけある)。
// 新しい DB で外部キー違反により migration 全体が止まらないよう、046 は対象 project の存在を条件にする。
const sql = readFileSync(new URL('../../../migrations/046_aedilis_issuer_grant.sql', import.meta.url), 'utf8');

describe('migration 046 on a fresh database', () => {
  it('inserts the aedilis grant only when both managed projects exist', () => {
    expect(sql).toMatch(/SELECT 'aedilis', 'excubitor', TRUE/);
    expect(sql).toMatch(/WHERE EXISTS \(SELECT 1 FROM managed_projects WHERE key = 'aedilis'\)/);
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM managed_projects WHERE key = 'excubitor'\)/);
    expect(sql).not.toMatch(/VALUES \('aedilis'/);
  });

  it('keeps the idempotent upsert', () => {
    expect(sql).toMatch(/ON CONFLICT \(target_project_key, issuer_project_key\) DO UPDATE SET/);
  });
});
