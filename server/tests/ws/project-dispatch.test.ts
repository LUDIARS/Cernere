import { describe, expect, it, vi, beforeEach } from "vitest";

const mockGetUserColumns = vi.fn();
vi.mock("../../src/project/service.js", () => ({
  getUserColumns: (...args: unknown[]) => mockGetUserColumns(...args),
}));

const mockGetSharedUserColumns = vi.fn();
const mockSetSharedUserColumns = vi.fn();
vi.mock("../../src/project/data-sharing.js", () => ({
  getSharedUserColumns: (...args: unknown[]) => mockGetSharedUserColumns(...args),
  setSharedUserColumns: (...args: unknown[]) => mockSetSharedUserColumns(...args),
}));

const { dispatchProjectCommand } = await import("../../src/ws/project-dispatch.js");

describe("dispatchProjectCommand — managed_project.get_user_data routing", () => {
  beforeEach(() => {
    mockGetUserColumns.mockReset().mockResolvedValue({ ok: "self" });
    mockGetSharedUserColumns.mockReset().mockResolvedValue({ ok: "shared" });
    mockSetSharedUserColumns.mockReset().mockResolvedValue({ ok: true, updated: ["name"] });
  });

  it("self-read (no targetProjectKey) uses the existing self-scoped path, unchanged", async () => {
    const result = await dispatchProjectCommand("aedilis", "managed_project", "get_user_data", {
      userId: "user-1",
      columns: ["foo"],
    });
    expect(mockGetUserColumns).toHaveBeenCalledWith("aedilis", "user-1", ["foo"]);
    expect(mockGetSharedUserColumns).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: "self" });
  });

  it("targetProjectKey equal to the connected projectKey behaves as self-read", async () => {
    await dispatchProjectCommand("aedilis", "managed_project", "get_user_data", {
      userId: "user-1",
      targetProjectKey: "aedilis",
    });
    expect(mockGetUserColumns).toHaveBeenCalledWith("aedilis", "user-1", undefined);
    expect(mockGetSharedUserColumns).not.toHaveBeenCalled();
  });

  it("targetProjectKey differing from the connected projectKey routes through data_sharing enforcement", async () => {
    const result = await dispatchProjectCommand("aedilis", "managed_project", "get_user_data", {
      userId: "user-1",
      targetProjectKey: "vantan_user",
      columns: ["department_name"],
    });
    expect(mockGetSharedUserColumns).toHaveBeenCalledWith(
      "aedilis", "vantan_user", "user-1", ["department_name"],
    );
    expect(mockGetUserColumns).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: "shared" });
  });

  it("propagates rejection when the caller is NOT listed in the target's data_sharing", async () => {
    mockGetSharedUserColumns.mockRejectedValue(
      new Error('Project "aedilis" has no data_sharing grant on project "vantan_user"'),
    );
    await expect(dispatchProjectCommand("aedilis", "managed_project", "get_user_data", {
      userId: "user-1",
      targetProjectKey: "vantan_user",
    })).rejects.toThrow(/no data_sharing grant/);
  });

  it("succeeds when the caller IS listed in the target's data_sharing", async () => {
    mockGetSharedUserColumns.mockResolvedValue({ department_name: "IT" });
    const result = await dispatchProjectCommand("aedilis", "managed_project", "get_user_data", {
      userId: "user-1",
      targetProjectKey: "vantan_user",
    });
    expect(result).toEqual({ department_name: "IT" });
  });
});

describe("dispatchProjectCommand — managed_project.set_user_data routing", () => {
  beforeEach(() => {
    mockSetSharedUserColumns.mockReset().mockResolvedValue({ ok: true, updated: ["name"] });
  });

  it("routes a differing targetProjectKey through readwrite data_sharing enforcement", async () => {
    const result = await dispatchProjectCommand("glab", "managed_project", "set_user_data", {
      userId: "user-1",
      targetProjectKey: "vantan_user",
      data: { name: "Neco" },
    });
    expect(mockSetSharedUserColumns).toHaveBeenCalledWith(
      "glab",
      "vantan_user",
      "user-1",
      { name: "Neco" },
    );
    expect(result).toEqual({ ok: true, updated: ["name"] });
  });
});
