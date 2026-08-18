import { beforeEach, describe, expect, it, vi } from "vitest";

interface ProjectCredentialRow {
  key: string;
  clientId: string;
  isActive: boolean;
  credentialGeneration: number;
}

const mockRows = vi.hoisted(() => vi.fn<() => ProjectCredentialRow[]>());

vi.mock("../../src/db/connection.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: (count: number) => Promise.resolve(mockRows().slice(0, count)),
        }),
      }),
    }),
  },
}));

const { isCurrentProjectCredential } = await import(
  "../../src/project/project-credential-state.js"
);

const currentProject: ProjectCredentialRow = {
  key: "ostiarius",
  clientId: "client-1",
  isActive: true,
  credentialGeneration: 2,
};

describe("isCurrentProjectCredential", () => {
  beforeEach(() => {
    mockRows.mockReset();
    mockRows.mockReturnValue([]);
  });

  it("accepts only the active project with matching identity and generation", async () => {
    mockRows.mockReturnValue([currentProject]);

    await expect(
      isCurrentProjectCredential("client-1", "ostiarius", 2),
    ).resolves.toBe(true);
  });

  it.each<[string, ProjectCredentialRow | undefined]>([
    ["missing project", undefined],
    ["inactive project", { ...currentProject, isActive: false }],
    ["different project key", { ...currentProject, key: "other-project" }],
    ["different client", { ...currentProject, clientId: "client-2" }],
    ["rotated generation", { ...currentProject, credentialGeneration: 3 }],
  ])("rejects a %s", async (_case, row) => {
    mockRows.mockReturnValue(row ? [row] : []);

    await expect(
      isCurrentProjectCredential("client-1", "ostiarius", 2),
    ).resolves.toBe(false);
  });
});
