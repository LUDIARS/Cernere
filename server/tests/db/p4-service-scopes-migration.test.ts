import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { serviceScopeSchema } from "../../src/project/schema.js";

const migration = readFileSync(
  new URL("../../../migrations/058_p4_service_scopes.sql", import.meta.url),
  "utf8",
);

/** 認証集約 P4 共通契約の scope 表 (呼出元 key → scope)。 */
const DECLARED: Array<[string, string]> = [
  ["EducationLab", "glab-external:write"],
  ["EducationLab", "calliope-api:access"],
  ["calliope", "glab-external:write"],
  ["volputas", "persona-bridge:write"],
  ["discutere", "persona-export:read"],
];

describe("058 P4 service_scopes migration", () => {
  it("共通契約の scope 表を呼出元 project に宣言する", () => {
    for (const [projectKey, scope] of DECLARED) {
      expect(serviceScopeSchema.safeParse(scope).success).toBe(true);
      expect(migration).toMatch(new RegExp(`\\('${projectKey}',\\s*'${scope}'\\)`));
    }
  });

  it("既存の service_scopes を消さずに和集合でマージする", () => {
    expect(migration).toMatch(/jsonb_array_elements\(existing\)/);
    expect(migration).toMatch(/UNION\s+SELECT unnest\(grant_row\.scopes\)/);
    expect(migration).toMatch(/jsonb_set\(current_def, '\{service_scopes\}', merged, true\)/);
  });

  it("Calliope / Discutere を storage_slug 付きで最小登録し、既存登録は上書きしない", () => {
    for (const key of ["calliope", "discutere"]) {
      expect(migration).toMatch(
        new RegExp(`VALUES \\(\\s*'${key}',\\s*'${key}',[\\s\\S]*?ON CONFLICT \\(key\\) DO NOTHING`),
      );
    }
    expect(migration).not.toMatch(/ON CONFLICT \(key\) DO UPDATE/);
  });

  it("送り側になる Calliope / Discutere に excubitor の launch credential 発行許可を足す", () => {
    for (const key of ["calliope", "discutere"]) {
      expect(migration).toMatch(
        new RegExp(`SELECT '${key}', 'excubitor', TRUE[\\s\\S]*?ON CONFLICT \\(target_project_key, issuer_project_key\\) DO UPDATE`),
      );
    }
  });

  it("破壊的操作を含まない", () => {
    expect(migration).not.toMatch(/DROP (COLUMN|TABLE)/i);
    expect(migration).not.toMatch(/\bDELETE FROM\b/i);
    expect(migration).not.toMatch(/ALTER COLUMN/i);
  });
});
