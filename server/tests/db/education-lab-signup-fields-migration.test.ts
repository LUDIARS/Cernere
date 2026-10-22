import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitStatements } from "../../src/db/migration-files.js";
import { projectDefinitionSchema } from "../../src/project/schema.js";

const migration = readFileSync(
  new URL("../../../migrations/074_education_lab_signup_fields.sql", import.meta.url),
  "utf8",
);
const body = migration.replace(/--[^\n]*\n/g, "");
const schemaJson = JSON.parse(readFileSync(new URL("../../service/glab/schema.json", import.meta.url), "utf8"));

function signupFieldsOfMigration(): unknown {
  const literal = body.match(/'\{signup_fields\}',\s*'([\s\S]*?)'::jsonb/);
  expect(literal).not.toBeNull();
  return JSON.parse(literal![1]);
}

describe("074 EducationLab signup_fields", () => {
  it("1 文なので途中まで適用されない", () => {
    const statements = splitStatements(migration).filter((statement) => statement.trim().length > 0);
    expect(statements).toHaveLength(1);
  });

  it("EducationLab の行だけを更新し、行が無ければ何もしない (UPDATE のみ・INSERT しない)", () => {
    expect(body).toMatch(/^\s*UPDATE managed_projects\b/);
    expect(body).toMatch(/WHERE key = 'EducationLab';\s*$/);
    expect(body).not.toMatch(/\bINSERT\b/i);
  });

  it("再実行しても同じ結果になる (固定値の jsonb_set だけ)", () => {
    expect(body).toMatch(/jsonb_set\(\s*jsonb_set\(\s*schema_definition,\s*'\{endpoint\}'/);
    expect(body).toMatch(/'\{signup_fields\}'/);
    expect(body).not.toMatch(/schema_definition->'signup_fields'|jsonb_insert|version\s*\+/i);
  });

  it("frontend_url だけを GLAB の公開 URL にし、endpoint.url は変えない", () => {
    expect(body).toContain(`COALESCE(schema_definition->'endpoint', '{}'::jsonb) || '{"frontend_url": "https://glab.ai-run-do.com"}'::jsonb`);
    expect(body).not.toMatch(/"url":/);
  });

  it("074 時点では名前・役職・学科を vantan_user の必須 text として宣言する", () => {
    const declared = signupFieldsOfMigration();
    expect(declared).toEqual({
      version: 1,
      fields: [
        { project: "vantan_user", column: "name", label: "名前", required: true, input: "text", max_length: 200 },
        { project: "vantan_user", column: "role_title", label: "役職", required: true, input: "text", max_length: 200 },
        { project: "vantan_user", column: "department_name", label: "学科", required: true, input: "text", max_length: 200 },
      ],
    });
    expect(schemaJson.endpoint).toMatchObject({ url: "http://localhost:5187", frontend_url: "https://glab.ai-run-do.com" });
    expect(projectDefinitionSchema.safeParse(schemaJson).success).toBe(true);
  });

  it("破壊的操作を含まない", () => {
    expect(body).not.toMatch(/DROP (COLUMN|TABLE)/i);
    expect(body).not.toMatch(/\bDELETE FROM\b/i);
    expect(body).not.toMatch(/ALTER COLUMN/i);
  });
});
