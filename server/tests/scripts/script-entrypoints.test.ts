import { afterEach, describe, expect, it, vi } from "vitest";

const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  vi.doUnmock("../../src/db/connection.js");
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules();
});

describe.each([
  { name: "grant", argv: ["--project", "fixture", "--grant-to", "other"], load: () => import("../../scripts/grant-project-data-sharing.js") },
  { name: "oidc", argv: ["--name", "fixture", "--redirect", "https://example.test/callback"], load: () => import("../../scripts/register-oidc-client.js") },
])("$name CLI import boundary", ({ argv, load }) => {
  it.each([true, false])("resolves environment before DB import (agent success=%s)", async (success) => {
    vi.resetModules();
    vi.stubEnv("DATABASE_URL", undefined); vi.stubEnv("REDIS_URL", undefined);
    vi.stubEnv("CERNERE_DEV_LOG", "true");
    vi.stubEnv("EXCUBITOR_URL", "http://127.0.0.1:23456");
    vi.stubEnv("EXCUBITOR_AGENT_TOKEN", "fixture-token");
    process.argv = ["node", "script", ...argv];
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const events: string[] = [];
    let importedEnvironment: Record<string, string | undefined> | undefined;
    vi.doMock("../../src/db/connection.js", () => {
      events.push("db-import");
      importedEnvironment = { DATABASE_URL: process.env.DATABASE_URL, CERNERE_DEV_LOG: process.env.CERNERE_DEV_LOG };
      // Stop at the import boundary. The test must never allocate an actual DB pool.
      throw new Error("fixture-db-error-with-private-value");
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      events.push("fetch");
      return success
        ? Response.json({ source: "vault", secrets: { DATABASE_URL: "fixture-db", REDIS_URL: "fixture-redis" } })
        : new Response("fixture-private-response", { status: 401 });
    }));
    await load();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(events).toEqual(success ? ["fetch", "db-import"] : ["fetch"]);
    if (success) expect(importedEnvironment).toEqual({ DATABASE_URL: "fixture-db", CERNERE_DEV_LOG: "false" });
    expect(JSON.stringify(error.mock.calls)).not.toContain("fixture-");
  });
});
