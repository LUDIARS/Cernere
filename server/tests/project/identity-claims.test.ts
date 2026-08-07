import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ProjectDefinition } from "../../src/project/schema.js";

// db.select().from(managedProjects).where(...).limit(1) だけを差し替える。
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

// 実 SQL は張らない。呼ばれた文と引数だけを観測する。
const mockUnsafe = vi.fn();
const mockEnd = vi.fn();
vi.mock("postgres", () => ({
  default: () => Object.assign(mockUnsafe, { unsafe: mockUnsafe, end: mockEnd }),
}));

vi.mock("../../src/config.js", () => ({ config: { databaseUrl: "postgres://test/test" } }));

const { getIdentityClaims, resolveUserByClaim, loadDeclaredClaims } =
  await import("../../src/project/identity-claims.js");

function projectRow(identityClaims?: unknown) {
  const definition = {
    project: { key: "somesvc", name: "SomeSvc", description: "" },
    ...(identityClaims === undefined ? {} : { identity_claims: identityClaims }),
  } as unknown as ProjectDefinition;
  return [{ key: "somesvc", isActive: true, schemaDefinition: definition }];
}

describe("identity claims (declaration-driven, no service name hardcoded)", () => {
  beforeEach(() => {
    mockManagedProjectRow.mockReset();
    mockUnsafe.mockReset();
    mockEnd.mockReset();
    // postgres() の戻りは関数兼オブジェクト。unsafe/end を生やして返す。
    mockUnsafe.unsafe = mockUnsafe;
    mockUnsafe.end = mockEnd;
  });

  it("宣言が無いプロジェクトは claim を読めない (fail-closed)", async () => {
    mockManagedProjectRow.mockReturnValue(projectRow(undefined));
    await expect(getIdentityClaims("somesvc", "user-1")).rejects.toThrow(/declares no identity_claims/);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  it("空配列の宣言も読めない", async () => {
    mockManagedProjectRow.mockReturnValue(projectRow([]));
    await expect(getIdentityClaims("somesvc", "user-1")).rejects.toThrow(/declares no identity_claims/);
  });

  it("宣言済みの claim だけを返す", async () => {
    mockManagedProjectRow.mockReturnValue(projectRow(["discord_id"]));
    mockUnsafe.mockResolvedValue([{ discord_id: "12345" }]);

    const result = await getIdentityClaims("somesvc", "user-1");

    expect(result).toEqual({ discord_id: "12345" });
    const [sqlText, params] = mockUnsafe.mock.calls[0];
    expect(sqlText).toContain('SELECT "discord_id" FROM users');
    expect(params).toEqual(["user-1"]);
  });

  it("未宣言の claim を要求すると拒否する", async () => {
    mockManagedProjectRow.mockReturnValue(projectRow(["discord_id"]));
    await expect(getIdentityClaims("somesvc", "user-1", ["discord_username"]))
      .rejects.toThrow(/not declared/);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  it("許可リストに無い列名は claim として扱わない", async () => {
    // 定義側に password_hash を書かれても identity claim にはならない。
    mockManagedProjectRow.mockReturnValue(projectRow(["password_hash"]));
    await expect(loadDeclaredClaims("somesvc")).resolves.toEqual([]);
    await expect(getIdentityClaims("somesvc", "user-1")).rejects.toThrow(/declares no identity_claims/);
  });

  it("行が無いユーザは null 埋めで返す", async () => {
    mockManagedProjectRow.mockReturnValue(projectRow(["discord_id"]));
    mockUnsafe.mockResolvedValue([]);
    await expect(getIdentityClaims("somesvc", "user-1")).resolves.toEqual({ discord_id: null });
  });

  it("逆引きも宣言済みの claim でしか引けない", async () => {
    mockManagedProjectRow.mockReturnValue(projectRow(["discord_id"]));
    await expect(resolveUserByClaim("somesvc", "discord_username", "neco"))
      .rejects.toThrow(/not declared/);
  });

  it("逆引きは値をパラメータで渡す (識別子だけ補間)", async () => {
    mockManagedProjectRow.mockReturnValue(projectRow(["discord_id"]));
    mockUnsafe.mockResolvedValue([{ userId: "u1", displayName: "neco" }]);

    const result = await resolveUserByClaim("somesvc", "discord_id", "12345");

    expect(result).toEqual({ userId: "u1", displayName: "neco" });
    const [sqlText, params] = mockUnsafe.mock.calls[0];
    expect(sqlText).toContain('WHERE "discord_id" = $1');
    expect(params).toEqual(["12345"]);
  });

  it("該当なしは null", async () => {
    mockManagedProjectRow.mockReturnValue(projectRow(["discord_id"]));
    mockUnsafe.mockResolvedValue([]);
    await expect(resolveUserByClaim("somesvc", "discord_id", "nope")).resolves.toBeNull();
  });
});
