import { describe, expect, it, vi } from "vitest";
import { projectDefinitionSchema, type ProjectDefinition } from "../../src/project/schema.js";

// service.ts は import 時に db / cache 等へ触るので最小限を差し替える。
vi.mock("../../src/db/connection.js", () => ({ db: {} }));
vi.mock("../../src/config.js", () => ({ config: { databaseUrl: "postgres://test/test" } }));

const { preserveExistingDefinitionFields, withExistingProjectMeta } =
  await import("../../src/project/service.js");

const existing = { key: "EducationLab", name: "GLAB", description: "学校運営 hub" };

describe("withExistingProjectMeta — update_schema の partial-update", () => {
  it("project を持たない user_data だけの宣言に既存の key / name / description を補う", () => {
    const out = withExistingProjectMeta(
      { user_data: { columns: { available_now: { type: "boolean", module: "presence" } } } },
      existing,
    ) as Record<string, unknown>;
    expect(out.project).toEqual({ key: "EducationLab", name: "GLAB", description: "学校運営 hub" });
    expect(out.user_data).toBeDefined();
  });

  it("呼び出し側が明示した project.name / description は上書きしない", () => {
    const out = withExistingProjectMeta(
      { project: { key: "EducationLab", name: "Renamed", description: "" } },
      existing,
    ) as Record<string, unknown>;
    expect(out.project).toEqual({ key: "EducationLab", name: "Renamed", description: "" });
  });

  it("既存 description が空なら description は補わない (zod default に任せる)", () => {
    const out = withExistingProjectMeta({}, { ...existing, description: "" }) as Record<string, unknown>;
    expect(out.project).toEqual({ key: "EducationLab", name: "GLAB" });
  });

  it("object でない payload はそのまま返す (検証側で弾かせる)", () => {
    expect(withExistingProjectMeta(null, existing)).toBeNull();
    expect(withExistingProjectMeta([], existing)).toEqual([]);
  });

  it("不正な project 型を省略扱いにせず検証側で弾かせる", () => {
    for (const project of [null, [], "invalid"]) {
      const payload = { project };
      const completed = withExistingProjectMeta(payload, existing);
      expect(completed).toBe(payload);
      expect(projectDefinitionSchema.safeParse(completed).success).toBe(false);
    }
  });
});

describe("preserveExistingDefinitionFields — partial-update の既存値保持", () => {
  const oldDefinition: ProjectDefinition = {
    project: { key: "EducationLab", name: "GLAB", description: "学校運営 hub" },
    endpoint: { url: "https://glab.example.test" },
    data_sharing: [{ project_key: "vantan_user", access: "read" }],
    identity_claims: ["discord_id"],
  };

  it("省略された endpoint と管理者所有フィールドを保持する", () => {
    const updated: ProjectDefinition = {
      project: { key: "EducationLab", name: "GLAB", description: "" },
      user_data: { columns: {} },
    };

    expect(preserveExistingDefinitionFields(updated, oldDefinition)).toEqual({
      ...updated,
      project: oldDefinition.project,
      endpoint: oldDefinition.endpoint,
      data_sharing: oldDefinition.data_sharing,
      identity_claims: oldDefinition.identity_claims,
    });
  });

  it("明示された空の管理者所有フィールドは上書きしない", () => {
    const updated: ProjectDefinition = {
      project: { key: "EducationLab", name: "GLAB", description: "" },
      data_sharing: [],
      identity_claims: [],
    };

    const result = preserveExistingDefinitionFields(updated, oldDefinition);
    expect(result.data_sharing).toEqual([]);
    expect(result.identity_claims).toEqual([]);
  });
});
