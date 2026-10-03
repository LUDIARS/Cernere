import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../identity/fake-drizzle.js";
import { saveProjectCredentials } from "../../src/project/vault-credentials.js";

const fake = createFakeDb();
vi.mock("../../src/db/connection.js", () => ({ db: fake.db }));
vi.mock("../../src/config.js", () => ({ config: { databaseUrl: "unused" } }));
vi.mock("../../src/project/credentials.js", () => ({
  issueProjectSecret: async () => ({ clientSecret: "new-private-secret", clientSecretHash: "new-hash" }),
}));
vi.mock("../../src/project/storage-resolver.js", () => ({ allocateStorageSlug: async () => "aedilis" }));
const migrate = vi.fn(async () => ({ created: false, columnsAdded: [] }));
vi.mock("../../src/project/schema-migrator.js", () => ({ migrateProjectSchema: migrate }));
vi.mock("../../src/project/user-data-cache.js", () => ({}));
const { registerProject, rotateProjectSecret } = await import("../../src/project/service.js");
const { managedProjects } = await import("../../src/db/schema.js");
const payload = { project: { key: "aedilis", name: "Aedilis" } };
const fetchMock = vi.fn<typeof fetch>();
const deliver = (credentials: { key: string; clientId: string; clientSecret: string }) =>
  saveProjectCredentials(credentials, { service: "excubitor" });

beforeEach(() => {
  fake.inserts.length = 0; fake.updates.length = 0;
  migrate.mockClear();
  vi.stubEnv("EXCUBITOR_URL", "http://127.0.0.1:23456");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockImplementation(async (_url, init) => {
    // Assert at every external request, including the final secret PUT.
    expect(fake.inserts).toHaveLength(0); expect(fake.updates).toHaveLength(0);
    return Response.json(init?.method === "GET" ? { bindings: {}, projects: [] } : { ok: true });
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe.each(["register", "rotate"] as const)("%s credential persistence", (operation) => {
  function run() {
    fake.queueSelect(operation === "register" ? [] : [{ key: "aedilis", clientId: "old-private-id" }]);
    return operation === "register" ? registerProject(payload, undefined, deliver) : rotateProjectSecret("aedilis", deliver);
  }

  it("saves to Vault before any DB mutation and stores only the secret hash", async () => {
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const writes = [...fake.inserts, ...fake.updates].filter((row) => row.table === managedProjects);
    expect(writes).toHaveLength(1);
    expect(writes[0].values).toMatchObject({ clientSecretHash: "new-hash" });
    expect(JSON.stringify(writes[0].values)).not.toContain("new-private-secret");
  });

  it.each([0, 1, 2, 3])("does not mutate DB when Vault request %s fails", async (failure) => {
    let index = 0;
    fetchMock.mockImplementation(async (_url, init) => index++ === failure
      ? new Response("new-private-secret", { status: 500 })
      : Response.json(init?.method === "GET" ? { bindings: {}, projects: [] } : { ok: true }));
    await expect(run()).rejects.toThrow("Vault credential save failed");
    expect(fake.inserts).toHaveLength(0); expect(fake.updates).toHaveLength(0);
    expect(migrate).not.toHaveBeenCalled();
  });
});

it("reactivates without issuing credentials or overwriting Vault", async () => {
  fake.queueSelect([{ key: "aedilis", isActive: false }]);
  const delivery = vi.fn(deliver);
  const result = await registerProject(payload, undefined, delivery);
  expect(result.message).toBe("Project reactivated");
  expect(delivery).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(fake.updates[0].values).not.toHaveProperty("clientSecretHash");
});
