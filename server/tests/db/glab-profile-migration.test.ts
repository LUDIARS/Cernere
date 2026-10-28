import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitStatements } from "../../src/db/migration-files.js";
import { projectDefinitionSchema } from "../../src/project/schema.js";

const sql = readFileSync(new URL("../../../migrations/078_glab_profile_columns.sql", import.meta.url), "utf8");
const schema = JSON.parse(readFileSync(new URL("../../service/glab/schema.json", import.meta.url), "utf8"));

describe("GLab profile cutover contract", () => {
  it("keeps the transaction as one runner statement and propagates failures", () => {
    expect(splitStatements(sql).filter((statement) => statement.trim())).toHaveLength(1);
    expect(sql).toContain("EXCEPTION WHEN OTHERS");
    expect(sql).toContain("ERRCODE = 'P0001'");
  });

  it("declares own signup columns and preserves presence alongside profile", () => {
    expect(projectDefinitionSchema.safeParse(schema).success).toBe(true);
    expect(schema.signup_fields.version).toBe(3);
    expect(schema.signup_fields.fields.map((field: { column: string }) => field.column))
      .toEqual(["member_type", "name", "nickname", "role_title", "department_name", "grade", "company"]);
    for (const field of schema.signup_fields.fields) {
      expect(field.project).toBeUndefined();
      expect(schema.user_data.columns[field.column].module).toBe("profile");
    }
    expect(schema.user_data.columns.current_location.module).toBe("presence");
    expect(schema.data_sharing).toEqual([{ project_key: "aedilis", modules: ["profile"], access: "read" }]);
  });

  it("uses the canonical signup declaration in the migration", () => {
    const declaration = sql.match(/destination_definition, '\{signup_fields\}', '([\s\S]*?)'::jsonb/);
    expect(declaration).not.toBeNull();
    expect(JSON.parse(declaration![1]!).version).toBe(2); // Historical migration remains immutable.
  });
});
