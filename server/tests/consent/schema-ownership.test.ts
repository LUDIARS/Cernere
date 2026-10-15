/**
 * consent は project client が update_schema で宣言できるが上限外は保存しない。consent_mode と上限は
 * 管理者所有のまま (project client の自己申告では変えられない)。
 */
import { describe, expect, it, vi } from "vitest";
import { splitAdminOwnedSchemaFields } from "../../src/project/admin-owned-fields.js";
import { projectDefinitionSchema, type ProjectDefinition } from "../../src/project/schema.js";

vi.mock("../../src/db/connection.js", () => ({ db: {} }));
vi.mock("../../src/config.js", () => ({ config: { databaseUrl: "postgres://test/test" } }));

const { assertConsentDeclaration, preserveExistingDefinitionFields } = await import("../../src/project/service.js");

const consent = {
  version: 1,
  permissions: [{ key: "profile.email", level: "recommended", purpose: "通知", visible_to: ["self"] }],
};

function definition(extra: Record<string, unknown>): ProjectDefinition {
  return projectDefinitionSchema.parse({ project: { key: "svc", name: "Service" }, ...extra });
}

describe("schema_definition の consent / consent_mode の所有", () => {
  it("project client の update_schema から consent_mode を落とし、consent は残す", () => {
    const { projectOwned, submittedAdminOwned } = splitAdminOwnedSchemaFields({
      consent, consent_mode: "off", profile_access: { users: "all", read: ["email"], write: [] },
    });
    expect(projectOwned).toEqual({ consent });
    expect(submittedAdminOwned).toEqual(["profile_access", "consent_mode"]);
  });

  it("上限の内側の宣言は保存できる", () => {
    const def = definition({ consent, profile_access: { users: "all", read: ["email"], write: [] } });
    expect(() => assertConsentDeclaration(def, null)).not.toThrow();
  });

  it("上限外の宣言は保存しない (自己付与の禁止)", () => {
    const def = definition({ consent });
    expect(() => assertConsentDeclaration(def, null)).toThrow(/outside the administrator grant/);
  });

  it("上限は管理者所有フィールドを合成した後の定義で見る (auto-sync の partial update)", () => {
    const existing = definition({ profile_access: { users: "all", read: ["email"], write: [] }, consent_mode: "enforce" });
    const merged = preserveExistingDefinitionFields(definition({ consent }), existing);
    expect(merged.consent_mode).toBe("enforce");
    expect(() => assertConsentDeclaration(merged, existing)).not.toThrow();
  });

  it("user_data だけの auto-sync で保存済みの consent を消さない", () => {
    const existing = definition({ consent, profile_access: { users: "all", read: ["email"], write: [] } });
    expect(preserveExistingDefinitionFields(definition({}), existing).consent).toEqual(consent);
  });

  it("consent_mode は off / warn / enforce だけ", () => {
    expect(projectDefinitionSchema.safeParse({ project: { key: "svc", name: "S" }, consent_mode: "strict" }).success).toBe(false);
  });
});
