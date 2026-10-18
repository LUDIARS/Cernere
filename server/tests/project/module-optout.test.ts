import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ select: vi.fn(), unsafe: vi.fn(), end: vi.fn(), remove: vi.fn(), invalidate: vi.fn() }));
vi.mock("../../src/db/connection.js", () => ({ db: {
  insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
  select: () => ({ from: () => ({ where: () => ({ limit: mocks.select }) }) }),
  delete: () => ({ where: mocks.remove }),
} }));
vi.mock("postgres", () => ({ default: () => ({ unsafe: mocks.unsafe, end: mocks.end }) }));
vi.mock("../../src/project/user-data-cache.js", () => ({ invalidate: mocks.invalidate }));
import { setModuleOptout } from "../../src/project/service.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.unsafe.mockResolvedValueOnce([{ _deleted_columns: { old: "retained" }, presence: { present: true }, count: 0 }]).mockResolvedValue([]);
});

describe("module opt-out SQL binding", () => {
  it.each([1, 2])("uses contiguous typed parameters for %i cleared columns and retains the backup", async count => {
    mocks.select.mockResolvedValue([{ key: "EducationLab", storageSlug: "educationlab", schemaDefinition: {
      user_data: { columns: {
        presence: { module: "presence" }, ...(count === 2 ? { count: { module: "presence" } } : {}),
        untouched: { module: "other" },
      } },
    } }]);
    await setModuleOptout("user-1", "EducationLab", "presence");
    const [query, params] = mocks.unsafe.mock.calls[1];
    expect(query).toContain('"presence" = NULL');
    expect(query).not.toContain('"untouched"');
    expect(query).toContain('_deleted_columns = $1::jsonb');
    expect(query).toContain('WHERE user_id = $2');
    expect([...query.matchAll(/\$(\d+)/g)].map(match => Number(match[1]))).toEqual([1, 2]);
    expect(params).toHaveLength(2);
    expect(JSON.parse(params[0])).toEqual({ old: "retained", presence: { present: true }, ...(count === 2 ? { count: 0 } : {}) });
    expect(params[1]).toBe("user-1");
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).toHaveBeenCalledWith("user-1", "EducationLab");
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });
});
