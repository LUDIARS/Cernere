import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ProjectDefinition } from "../../src/project/schema.js";

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

const mockUnsafe = vi.fn();
const mockEnd = vi.fn();
vi.mock("postgres", () => ({
  default: () => Object.assign(mockUnsafe, { unsafe: mockUnsafe, end: mockEnd }),
}));

vi.mock("../../src/config.js", () => ({ config: { databaseUrl: "postgres://test/test" } }));

const { listUserData } = await import("../../src/project/user-data-query.js");

function projectRow(columns: Record<string, unknown>, identityClaims?: string[]) {
  const definition = {
    project: { key: "somesvc", name: "SomeSvc", description: "" },
    user_data: { columns },
    ...(identityClaims ? { identity_claims: identityClaims } : {}),
  } as unknown as ProjectDefinition;
  return [{ key: "somesvc", storageSlug: "somesvc", isActive: true, schemaDefinition: definition }];
}

const PRESENCE_COLUMNS = {
  available_now: { type: "boolean", module: "presence" },
  available_until: { type: "timestamp", module: "presence" },
};

describe("listUserData (declared columns only, no service name hardcoded)", () => {
  beforeEach(() => {
    mockManagedProjectRow.mockReset();
    mockUnsafe.mockReset();
    mockEnd.mockReset();
    mockUnsafe.unsafe = mockUnsafe;
    mockUnsafe.end = mockEnd;
    mockUnsafe.mockResolvedValue([]);
  });

  it("宣言済みカラムの等値条件と未失効判定を組み立てる", async () => {
    mockManagedProjectRow.mockReturnValue(projectRow(PRESENCE_COLUMNS));

    await listUserData("somesvc", {
      columns: ["available_now", "available_until"],
      where: { available_now: true },
      activeAt: { column: "available_until" },
    });

    const [sqlText, params] = mockUnsafe.mock.calls[0];
    expect(sqlText).toContain('FROM "project_data_somesvc" d JOIN users u ON u.id = d.user_id');
    expect(sqlText).toContain('d."available_now" = $1');
    expect(sqlText).toContain('(d."available_until" IS NULL OR d."available_until" > now())');
    expect(params).toEqual([true]);
  });

  it("未宣言のカラムは無言で無視せず拒否する", async () => {
    mockManagedProjectRow.mockReturnValue(projectRow(PRESENCE_COLUMNS));
    await expect(listUserData("somesvc", { columns: ["password_hash"] }))
      .rejects.toThrow(/not declared by project/);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  it("where の未宣言カラムも拒否する", async () => {
    mockManagedProjectRow.mockReturnValue(projectRow(PRESENCE_COLUMNS));
    await expect(listUserData("somesvc", { where: { is_admin: true } }))
      .rejects.toThrow(/not declared by project/);
  });

  it("論理削除済みカラムは宣言済み扱いしない", async () => {
    mockManagedProjectRow.mockReturnValue(projectRow({
      ...PRESENCE_COLUMNS,
      legacy_flag: { type: "boolean", module: "presence", _deleted: true },
    }));
    await expect(listUserData("somesvc", { columns: ["legacy_flag"] }))
      .rejects.toThrow(/not declared by project/);
  });

  it("activeAt に timestamp 以外を渡すと拒否する", async () => {
    mockManagedProjectRow.mockReturnValue(projectRow(PRESENCE_COLUMNS));
    await expect(listUserData("somesvc", { activeAt: { column: "available_now" } }))
      .rejects.toThrow(/requires a timestamp column/);
  });

  it("identity claim は宣言が無ければ返さない", async () => {
    mockManagedProjectRow.mockReturnValue(projectRow(PRESENCE_COLUMNS));
    await expect(listUserData("somesvc", { claims: ["discord_id"] }))
      .rejects.toThrow(/not declared by project/);
  });

  it("宣言済みの identity claim は SELECT に載る", async () => {
    mockManagedProjectRow.mockReturnValue(projectRow(PRESENCE_COLUMNS, ["discord_id"]));

    await listUserData("somesvc", { columns: ["available_now"], claims: ["discord_id"] });

    const [sqlText] = mockUnsafe.mock.calls[0];
    expect(sqlText).toContain('u."discord_id"');
  });

  it("未登録の project key は DB 識別子に補間しない", async () => {
    mockManagedProjectRow.mockReturnValue([]);
    await expect(listUserData('bad"; DROP TABLE users; --')).rejects.toThrow(/Project not found/);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  it("limit は上限で頭打ちにする", async () => {
    mockManagedProjectRow.mockReturnValue(projectRow(PRESENCE_COLUMNS));
    await listUserData("somesvc", { limit: 999999 });
    const [sqlText] = mockUnsafe.mock.calls[0];
    expect(sqlText).toContain("LIMIT 1000");
  });

  it.each([
    ["non-string columns", { columns: [{}] }],
    ["non-object where", { where: [] }],
    ["structured where value", { where: { available_now: { $ne: false } } }],
    ["invalid activeAt timestamp", { activeAt: { column: "available_until", at: "tomorrow-ish" } }],
    ["non-finite limit", { limit: Number.NaN }],
  ])("rejects malformed runtime input: %s", async (_label, input) => {
    await expect(listUserData("somesvc", input as never)).rejects.toThrow();
    expect(mockUnsafe).not.toHaveBeenCalled();
  });
  it("表名は project key ではなく行の storage_slug から解決する", async () => {
    const definition = {
      project: { key: "EducationLab", name: "EducationLab", description: "" },
      user_data: { columns: PRESENCE_COLUMNS },
    } as unknown as ProjectDefinition;
    mockManagedProjectRow.mockReturnValue([
      { key: "EducationLab", storageSlug: "educationlab", isActive: true, schemaDefinition: definition },
    ]);

    await listUserData("EducationLab", { columns: ["available_now"] });

    const [sqlText] = mockUnsafe.mock.calls[0];
    expect(sqlText).toContain('FROM "project_data_educationlab" d');
    expect(sqlText).not.toContain("EducationLab");
  });

  it("ハイフン付き project key も storage_slug 経由で検索できる", async () => {
    const definition = {
      project: { key: "my-app", name: "My App", description: "" },
      user_data: { columns: PRESENCE_COLUMNS },
    } as unknown as ProjectDefinition;
    mockManagedProjectRow.mockReturnValue([
      { key: "my-app", storageSlug: "my_app", isActive: true, schemaDefinition: definition },
    ]);

    await listUserData("my-app", { columns: ["available_now"] });

    const [sqlText] = mockUnsafe.mock.calls[0];
    expect(sqlText).toContain('FROM "project_data_my_app" d');
    expect(sqlText).not.toContain("my-app");
  });

  it("storage_slug が欠けている/不正な行は無言で通さず失敗する", async () => {
    const definition = {
      project: { key: "somesvc", name: "SomeSvc", description: "" },
      user_data: { columns: PRESENCE_COLUMNS },
    } as unknown as ProjectDefinition;
    mockManagedProjectRow.mockReturnValue([
      { key: "somesvc", storageSlug: null, isActive: true, schemaDefinition: definition },
    ]);
    await expect(listUserData("somesvc", { columns: ["available_now"] }))
      .rejects.toThrow(/Project storage configuration is invalid/);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });
});
