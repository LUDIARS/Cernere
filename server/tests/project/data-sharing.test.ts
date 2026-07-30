import { describe, expect, it } from "vitest";
import {
  resolveSharedColumnNames,
  resolveSharedWritableColumnNames,
} from "../../src/project/data-sharing.js";
import {
  dataShareDefinitionSchema,
  projectDefinitionSchema,
  type ProjectDefinition,
} from "../../src/project/schema.js";

function makeTargetDefinition(overrides: Partial<ProjectDefinition> = {}): ProjectDefinition {
  return {
    project: { key: "vantan_user", name: "EducationPartner User", description: "" },
    user_data: {
      columns: {
        department_name: { type: "text", module: "profile", nullable: true },
        grade: { type: "integer", module: "profile", nullable: true },
        name: { type: "text", module: "profile", nullable: true },
        desired_job: { type: "text", module: "profile", nullable: true },
        internal_note: { type: "text", module: "admin", nullable: true },
      },
    },
    ...overrides,
  };
}

describe("resolveSharedColumnNames", () => {
  it("allows the read when the caller has a matching access: \"read\" entry", () => {
    const target = makeTargetDefinition({
      data_sharing: [{ project_key: "aedilis", access: "read" }],
    });
    const names = resolveSharedColumnNames("aedilis", target);
    expect(names.sort()).toEqual(
      ["department_name", "desired_job", "grade", "internal_note", "name"].sort(),
    );
  });

  it("allows the read when access is \"readwrite\" (readwrite implies read)", () => {
    const target = makeTargetDefinition({
      data_sharing: [{ project_key: "aedilis", access: "readwrite" }],
    });
    expect(() => resolveSharedColumnNames("aedilis", target)).not.toThrow();
  });

  it("throws forbidden when there is no matching data_sharing entry", () => {
    const target = makeTargetDefinition({
      data_sharing: [{ project_key: "some_other_project", access: "read" }],
    });
    expect(() => resolveSharedColumnNames("aedilis", target)).toThrow(/no data_sharing grant/);
  });

  it("throws forbidden when data_sharing is entirely absent", () => {
    const target = makeTargetDefinition();
    expect(() => resolveSharedColumnNames("aedilis", target)).toThrow(/no data_sharing grant/);
  });

  it("restricts columns to the declared modules only", () => {
    const target = makeTargetDefinition({
      data_sharing: [{ project_key: "aedilis", access: "read", modules: ["profile"] }],
    });
    const names = resolveSharedColumnNames("aedilis", target);
    expect(names.sort()).toEqual(["department_name", "desired_job", "grade", "name"].sort());
    expect(names).not.toContain("internal_note");
  });

  it("restricts reads to the administrator-selected columns", () => {
    const target = makeTargetDefinition({
      data_sharing: [{
        project_key: "aedilis",
        access: "read",
        columns: ["name", "grade"],
      }],
    });
    expect(resolveSharedColumnNames("aedilis", target))
      .toEqual(["grade", "name"]);
  });

  it("intersects selected columns with the module restriction", () => {
    const target = makeTargetDefinition({
      data_sharing: [{
        project_key: "aedilis",
        access: "read",
        modules: ["profile"],
        columns: ["name", "internal_note"],
      }],
    });
    expect(resolveSharedColumnNames("aedilis", target)).toEqual(["name"]);
  });

  it("treats an explicit empty column selection as deny-all", () => {
    const target = makeTargetDefinition({
      data_sharing: [{ project_key: "aedilis", access: "read", columns: [] }],
    });
    expect(resolveSharedColumnNames("aedilis", target)).toEqual([]);
  });

  it("further narrows to explicitly requested columns within the allowed set", () => {
    const target = makeTargetDefinition({
      data_sharing: [{ project_key: "aedilis", access: "read", modules: ["profile"] }],
    });
    const names = resolveSharedColumnNames("aedilis", target, ["grade", "internal_note"]);
    // internal_note は profile モジュール外なので、リクエストされても除外される
    expect(names).toEqual(["grade"]);
  });

  it("excludes logically-deleted columns", () => {
    const target = makeTargetDefinition({
      data_sharing: [{ project_key: "aedilis", access: "read" }],
      user_data: {
        columns: {
          department_name: { type: "text", module: "profile", nullable: true },
          old_column: { type: "text", module: "profile", nullable: true, _deleted: true },
        },
      },
    });
    const names = resolveSharedColumnNames("aedilis", target);
    expect(names).toEqual(["department_name"]);
  });

  it("defaults a data_sharing entry's access to \"read\" when parsed through the schema (zod .default)", () => {
    // dataShareDefinitionSchema has `.access: z.enum([...]).optional().default("read")`.
    // Confirm the parsed (production) shape always has `access` populated, and that
    // resolveSharedColumnNames allows the read for such an entry.
    const parsed = dataShareDefinitionSchema.parse({ project_key: "aedilis" });
    expect(parsed.access).toBe("read");

    const target = makeTargetDefinition({ data_sharing: [parsed] });
    expect(() => resolveSharedColumnNames("aedilis", target)).not.toThrow();
  });
});

describe("resolveSharedWritableColumnNames", () => {
  it("allows only columns covered by a matching readwrite grant", () => {
    const target = makeTargetDefinition({
      data_sharing: [{ project_key: "EducationLab", access: "readwrite", modules: ["profile"] }],
    });
    expect(resolveSharedWritableColumnNames(
      "EducationLab",
      target,
      ["name", "department_name", "internal_note"],
    )).toEqual(["name", "department_name"]);
  });

  it("allows writes only to administrator-selected columns", () => {
    const target = makeTargetDefinition({
      data_sharing: [{
        project_key: "EducationLab",
        access: "readwrite",
        columns: ["name"],
      }],
    });
    expect(resolveSharedWritableColumnNames(
      "EducationLab",
      target,
      ["name", "department_name"],
    )).toEqual(["name"]);
  });

  it("rejects a read-only grant", () => {
    const target = makeTargetDefinition({
      data_sharing: [{ project_key: "EducationLab", access: "read", modules: ["profile"] }],
    });
    expect(() => resolveSharedWritableColumnNames("EducationLab", target, ["name"]))
      .toThrow(/no readwrite data_sharing grant/);
  });
});

describe("data_sharing column schema", () => {
  it("accepts active selected columns", () => {
    const parsed = makeTargetDefinition({
      data_sharing: [{
        project_key: "aedilis",
        access: "read",
        columns: ["name", "grade"],
      }],
    });
    expect(() => dataShareDefinitionSchema.parse(parsed.data_sharing?.[0])).not.toThrow();
  });

  it("rejects duplicate grants, duplicate columns, and inactive column names", () => {
    const result = projectDefinitionSchema.safeParse(makeTargetDefinition({
      data_sharing: [
        {
          project_key: "aedilis",
          access: "read",
          columns: ["name", "name", "missing"],
        },
        { project_key: "aedilis", access: "read", columns: ["grade"] },
      ],
    }));
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(messages).toContain("duplicate data_sharing project: aedilis");
    expect(messages).toContain("duplicate shared column: name");
    expect(messages).toContain("shared column is not active in user_data: missing");
  });
});
