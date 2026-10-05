import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { serviceScopeSchema } from "../../src/project/schema.js";

const migration = readFileSync(
  new URL("../../../migrations/059_p4_glab_bot_project.sql", import.meta.url),
  "utf8",
);

describe("059 P4 glab-bot project migration", () => {
  it("glab-bot を storage_slug 付きで最小登録し、既存登録は上書きしない", () => {
    expect(migration).toMatch(/VALUES \(\s*'glab-bot',\s*'glab_bot',[\s\S]*?ON CONFLICT \(key\) DO NOTHING/);
    expect(migration).not.toMatch(/ON CONFLICT \(key\) DO UPDATE/);
    // migration 043 の storage_slug CHECK (^[a-z][a-z0-9_]{1,49}$) を満たす
    expect("glab_bot").toMatch(/^[a-z][a-z0-9_]{1,49}$/);
  });

  it("glab-external:write を service_scopes に宣言し、既存 scope は和集合で残す", () => {
    expect(serviceScopeSchema.safeParse("glab-external:write").success).toBe(true);
    expect(migration).toMatch(/"service_scopes": \["glab-external:write"\]/);
    expect(migration).toMatch(/UNION\s+SELECT 'glab-external:write'/);
    expect(migration).toMatch(/WHERE key = 'glab-bot'/);
  });

  it("excubitor に glab-bot の launch credential 発行許可を足す", () => {
    expect(migration).toMatch(
      /SELECT 'glab-bot', 'excubitor', TRUE[\s\S]*?ON CONFLICT \(target_project_key, issuer_project_key\) DO UPDATE/,
    );
  });

  it("破壊的操作を含まない", () => {
    expect(migration).not.toMatch(/DROP (COLUMN|TABLE)/i);
    expect(migration).not.toMatch(/\bDELETE FROM\b/i);
    expect(migration).not.toMatch(/ALTER COLUMN/i);
  });
});
