import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ProjectDefinition } from "../../src/project/schema.js";

// db.select(...).from(table)... の戻り値をテストごとに差し替えられる最小の
// チェーン可能モック。 users テーブル (export-auth.ts の admin 判定) と
// managedProjects テーブル (project-schema-handler.ts の本体データ) の
// 2 系統を、実 schema オブジェクトの参照一致で振り分ける。
// managedProjects 側は「.from() を直接 await する」パターン (key 省略時) と
// 「.where().limit() を挟む」パターン (key 指定時) の両方をサポートする。
const mockUsersRows = vi.fn<() => Array<{ role: string }>>();
const mockProjectsRows = vi.fn<() => Array<{
  key: string;
  name: string;
  description: string;
  schemaDefinition: unknown;
  isActive: boolean;
}>>();

vi.mock("../../src/db/connection.js", async () => {
  const schema = await import("../../src/db/schema.js");
  return {
    db: {
      select: () => ({
        from: (table: unknown) => {
          if (table === schema.managedProjects) {
            const rows = mockProjectsRows();
            return {
              where: () => ({ limit: (_n: number) => Promise.resolve(rows.slice(0, _n)) }),
              // key 省略時: db.select(cols).from(managedProjects) を直接 await するため
              // thenable にしておく。
              then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
                Promise.resolve(rows).then(resolve, reject),
            };
          }
          return {
            where: () => ({ limit: (_n: number) => Promise.resolve(mockUsersRows().slice(0, _n)) }),
          };
        },
      }),
    },
  };
});

const { exportProjectSchemas } = await import("../../src/http/project-schema-handler.js");
const { generateAccessToken, generateProjectToken } = await import("../../src/auth/jwt.js");

function activeProject(key: string, isActive = true): {
  key: string; name: string; description: string; schemaDefinition: ProjectDefinition; isActive: boolean;
} {
  const def: ProjectDefinition = {
    project: { key, name: `Project ${key}`, description: `desc ${key}` },
    user_data: {
      columns: {
        department_name: { type: "text", module: "profile", nullable: true },
        grade: { type: "integer", module: "profile", nullable: true },
      },
    },
    data_sharing: [{ project_key: "some_service", access: "read" }],
  };
  return {
    key, name: `Project ${key}`, description: `desc ${key}`, schemaDefinition: def, isActive,
  };
}

describe("GET /api/admin/projects/schema-export handler (db mocked)", () => {
  beforeEach(() => {
    mockUsersRows.mockReset();
    mockProjectsRows.mockReset();
  });

  it("401s when no bearer token is present (classifyError maps /Unauthorized/i -> 401)", async () => {
    await expect(exportProjectSchemas("", "")).rejects.toThrow(/Unauthorized/);
  });

  it("rejects a structurally invalid bearer token", async () => {
    // NOTE: this surfaces as jwt.ts's "Invalid or expired token" (no literal
    // "Unauthorized" substring) — a pre-existing app.ts classifyError() gap
    // shared with every other route using requireUserId/verifyToken, not
    // something introduced by this endpoint. The empty-header case above is
    // the one that reliably maps to 401 via classifyError's /Unauthorized/i.
    await expect(exportProjectSchemas("Bearer not-a-jwt", "")).rejects.toThrow(/Invalid or expired token/);
  });

  it("403s for a valid user token whose role is not admin (classifyError maps /Forbidden/i -> 403)", async () => {
    const token = generateAccessToken("user-1", "general");
    mockUsersRows.mockReturnValue([{ role: "general" }]);
    await expect(exportProjectSchemas(`Bearer ${token}`, "")).rejects.toThrow(/Forbidden/);
  });

  it("200s for a valid admin user token and returns only active projects, exact {key,name,description,schemaDefinition} shape", async () => {
    const token = generateAccessToken("admin-1", "admin");
    mockUsersRows.mockReturnValue([{ role: "admin" }]);
    mockProjectsRows.mockReturnValue([
      activeProject("vantan_user", true),
      activeProject("retired_project", false),
    ]);

    const result = await exportProjectSchemas(`Bearer ${token}`, "");
    expect(result.status).toBe("200 OK");
    const projects = (result.data as { projects: unknown[] }).projects as Array<Record<string, unknown>>;

    // inactive project excluded when no ?key= filter given
    expect(projects.map((p) => p.key)).toEqual(["vantan_user"]);

    // strict shape: exactly key/name/description/schemaDefinition, nothing else
    for (const p of projects) {
      expect(Object.keys(p).sort()).toEqual(["description", "key", "name", "schemaDefinition"]);
    }
    expect(projects[0].schemaDefinition).toMatchObject({
      project: { key: "vantan_user" },
      user_data: { columns: { department_name: { type: "text", module: "profile" } } },
    });

    // never resembles project_data_<key> row contents (no user_id / column *values*,
    // only the schema *shape* metadata)
    const serialized = JSON.stringify(projects);
    expect(serialized).not.toMatch(/project_data_/);
    expect(serialized).not.toMatch(/"user_id"/);
  });

  it("200s for a valid project/service token (no users table lookup needed)", async () => {
    const token = generateProjectToken("client-1", "ostiarius");
    mockProjectsRows.mockReturnValue([activeProject("vantan_user", true)]);

    const result = await exportProjectSchemas(`Bearer ${token}`, "");
    expect(result.status).toBe("200 OK");
    expect(mockUsersRows).not.toHaveBeenCalled();
    const projects = (result.data as { projects: unknown[] }).projects as Array<Record<string, unknown>>;
    expect(projects).toHaveLength(1);
    expect(projects[0].key).toBe("vantan_user");
  });

  it("?key= filters to a single project and includes it even when inactive", async () => {
    const token = generateProjectToken("client-1", "ostiarius");
    mockProjectsRows.mockReturnValue([activeProject("retired_project", false)]);

    const result = await exportProjectSchemas(`Bearer ${token}`, "key=retired_project");
    expect(result.status).toBe("200 OK");
    const projects = (result.data as { projects: unknown[] }).projects as Array<Record<string, unknown>>;
    expect(projects).toHaveLength(1);
    expect(projects[0].key).toBe("retired_project");
  });

  it("404s when ?key= does not match any project", async () => {
    const token = generateProjectToken("client-1", "ostiarius");
    mockProjectsRows.mockReturnValue([]);

    await expect(exportProjectSchemas(`Bearer ${token}`, "key=nonexistent"))
      .rejects.toThrow(/not found/i);
  });
});
