import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ProjectDefinition } from "../../src/project/schema.js";

// db.select().from(managedProjects).where(...).limit(1) の戻り値を
// テストごとに差し替えられるようにする最小のチェーン可能モック。
const mockManagedProjectRow = vi.fn();
vi.mock("../../src/db/connection.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(mockManagedProjectRow()),
        }),
      }),
    }),
  },
}));

// 実データ取得 (postgres 直叩き) は getUserColumns 側の責務なので、ここでは
// 「正しい引数で呼ばれたか」だけを検証し、実 DB には触れない。
const mockGetUserColumns = vi.fn();
const mockSetUserData = vi.fn();
vi.mock("../../src/project/service.js", () => ({
  getUserColumns: (...args: unknown[]) => mockGetUserColumns(...args),
  setUserData: (...args: unknown[]) => mockSetUserData(...args),
}));

const { getSharedUserColumns, setSharedUserColumns } = await import("../../src/project/data-sharing.js");

function targetRow(definition: ProjectDefinition, isActive = true) {
  return [{ key: definition.project.key, isActive, schemaDefinition: definition }];
}

describe("getSharedUserColumns (data_sharing enforcement, db + service delegation mocked)", () => {
  beforeEach(() => {
    mockManagedProjectRow.mockReset();
    mockGetUserColumns.mockReset();
    mockSetUserData.mockReset();
  });

  it("rejects a caller project that is NOT listed in the target's data_sharing", async () => {
    const target: ProjectDefinition = {
      project: { key: "vantan_user", name: "Vantan User", description: "" },
      data_sharing: [{ project_key: "some_other_project", access: "read" }],
      user_data: {
        columns: { name: { type: "text", module: "profile", nullable: true } },
      },
    };
    mockManagedProjectRow.mockReturnValue(targetRow(target));

    await expect(getSharedUserColumns("aedilis", "vantan_user", "user-1"))
      .rejects.toThrow(/no data_sharing grant/);
    expect(mockGetUserColumns).not.toHaveBeenCalled();
  });

  it("succeeds and delegates to getUserColumns when the caller IS listed (module-restricted)", async () => {
    const target: ProjectDefinition = {
      project: { key: "vantan_user", name: "Vantan User", description: "" },
      data_sharing: [{ project_key: "aedilis", access: "read", modules: ["profile"] }],
      user_data: {
        columns: {
          department_name: { type: "text", module: "profile", nullable: true },
          grade: { type: "integer", module: "profile", nullable: true },
          internal_note: { type: "text", module: "admin", nullable: true },
        },
      },
    };
    mockManagedProjectRow.mockReturnValue(targetRow(target));
    mockGetUserColumns.mockResolvedValue({ department_name: "IT", grade: 2 });

    const result = await getSharedUserColumns("aedilis", "vantan_user", "user-1");

    // internal_note (admin モジュール) は data_sharing の modules: ["profile"] に
    // 含まれないため、getUserColumns に渡す許可カラムから除外されているはず。
    const calledColumns = mockGetUserColumns.mock.calls[0][2] as string[];
    expect(calledColumns.sort()).toEqual(["department_name", "grade"]);
    expect(calledColumns).not.toContain("internal_note");
    expect(mockGetUserColumns).toHaveBeenCalledWith("vantan_user", "user-1", calledColumns);
    expect(result).toEqual({ department_name: "IT", grade: 2 });
  });

  it("404s when the target project does not exist", async () => {
    mockManagedProjectRow.mockReturnValue([]);
    await expect(getSharedUserColumns("aedilis", "unknown_project", "user-1"))
      .rejects.toThrow(/not found/i);
    expect(mockGetUserColumns).not.toHaveBeenCalled();
  });

  it("404s when the target project is inactive (fail closed, not silently partial)", async () => {
    const target: ProjectDefinition = {
      project: { key: "vantan_user", name: "Vantan User", description: "" },
      data_sharing: [{ project_key: "aedilis", access: "read" }],
    };
    mockManagedProjectRow.mockReturnValue(targetRow(target, false));

    await expect(getSharedUserColumns("aedilis", "vantan_user", "user-1"))
      .rejects.toThrow(/not found/i);
    expect(mockGetUserColumns).not.toHaveBeenCalled();
  });
});

describe("setSharedUserColumns (readwrite enforcement, db + service delegation mocked)", () => {
  beforeEach(() => {
    mockManagedProjectRow.mockReset();
    mockSetUserData.mockReset().mockResolvedValue({ ok: true, updated: ["name"] });
  });

  it("delegates an allowed profile update to the target project", async () => {
    const target: ProjectDefinition = {
      project: { key: "vantan_user", name: "Vantan User", description: "" },
      data_sharing: [{ project_key: "glab", access: "readwrite", modules: ["profile"] }],
      user_data: {
        columns: {
          name: { type: "text", module: "profile", nullable: false },
          internal_note: { type: "text", module: "admin", nullable: true },
        },
      },
    };
    mockManagedProjectRow.mockReturnValue(targetRow(target));

    await setSharedUserColumns("glab", "vantan_user", "user-1", { name: "Neco" });

    expect(mockSetUserData).toHaveBeenCalledWith(
      "vantan_user",
      "user-1",
      { name: "Neco" },
    );
  });

  it("rejects a read-only grant", async () => {
    const target: ProjectDefinition = {
      project: { key: "vantan_user", name: "Vantan User", description: "" },
      data_sharing: [{ project_key: "glab", access: "read", modules: ["profile"] }],
      user_data: { columns: { name: { type: "text", module: "profile", nullable: false } } },
    };
    mockManagedProjectRow.mockReturnValue(targetRow(target));

    await expect(setSharedUserColumns("glab", "vantan_user", "user-1", { name: "Neco" }))
      .rejects.toThrow(/no readwrite data_sharing grant/);
    expect(mockSetUserData).not.toHaveBeenCalled();
  });

  it("rejects any column outside the granted modules", async () => {
    const target: ProjectDefinition = {
      project: { key: "vantan_user", name: "Vantan User", description: "" },
      data_sharing: [{ project_key: "glab", access: "readwrite", modules: ["profile"] }],
      user_data: {
        columns: {
          name: { type: "text", module: "profile", nullable: false },
          internal_note: { type: "text", module: "admin", nullable: true },
        },
      },
    };
    mockManagedProjectRow.mockReturnValue(targetRow(target));

    await expect(setSharedUserColumns("glab", "vantan_user", "user-1", {
      name: "Neco",
      internal_note: "blocked",
    })).rejects.toThrow(/not writable/);
    expect(mockSetUserData).not.toHaveBeenCalled();
  });
});
