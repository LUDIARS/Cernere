import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliverProjectCredentials } from "../../src/project/credential-delivery.js";
import { parseCredentialArgs } from "../../scripts/project-credential-args.js";

const credentials = { key: "aedilis", clientId: "dummy-client-id", clientSecret: "dummy-client-secret" };
const readFile = vi.fn(async () => JSON.stringify({ project: { key: "aedilis", name: "Aedilis" } }));
vi.mock("node:fs/promises", () => ({ readFile }));
const register = vi.fn(async (_payload: unknown, _user: unknown, deliver: DeliverProjectCredentials) => {
  await deliver(credentials); return credentials;
});
const rotate = vi.fn(async (_key: string, deliver: DeliverProjectCredentials) => {
  await deliver(credentials); return credentials;
});
vi.mock("../../src/project/service.js", () => ({ registerProject: register, rotateProjectSecret: rotate }));
const { runCredentialCommand } = await import("../../scripts/project-credential-command.js");

beforeEach(() => {
  vi.stubEnv("EXCUBITOR_URL", "http://127.0.0.1:23456");
  vi.stubEnv("DATABASE_URL", "postgres://test/test");
  vi.stubEnv("REDIS_URL", "redis://test");
  vi.stubEnv("CERNERE_DEV_LOG", "false");
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => Response.json(
    init?.method === "GET" ? { bindings: {}, projects: [] } : { ok: true })));
  register.mockClear(); rotate.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe.each(["register", "rotate"] as const)("%s CLI", (operation) => {
  const argv = [operation === "register" ? "--file" : "--project", "aedilis", "--service", "excubitor"];
  it("routes generated values into Vault and returns only a fixed success message", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await runCredentialCommand(operation, argv);
    expect(result.exitCode).toBe(0);
    expect(JSON.stringify(result)).not.toContain(credentials.clientId);
    expect(JSON.stringify(result)).not.toContain(credentials.clientSecret);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(log).not.toHaveBeenCalled();
  });

  it("sanitizes thrown DB errors as well as Vault failures", async () => {
    const selected = operation === "register" ? register : rotate;
    selected.mockRejectedValueOnce(new Error(`${credentials.clientId} ${credentials.clientSecret}`));
    const result = await runCredentialCommand(operation, argv);
    expect(result.exitCode).toBe(1);
    expect(JSON.stringify(result)).not.toContain(credentials.clientId);
    expect(JSON.stringify(result)).not.toContain(credentials.clientSecret);
    vi.mocked(fetch).mockRejectedValueOnce(new Error(credentials.clientSecret));
    const failed = await runCredentialCommand(operation, argv);
    expect(failed.exitCode).toBe(1);
    expect(JSON.stringify(failed)).not.toContain(credentials.clientSecret);
  });

  it("rejects missing service or endpoint before importing DB operations", async () => {
    expect((await runCredentialCommand(operation, argv.slice(0, 2))).exitCode).toBe(1);
    vi.stubEnv("EXCUBITOR_URL", ""); vi.stubEnv("EXCUBITOR_PORT", "");
    expect((await runCredentialCommand(operation, argv)).exitCode).toBe(1);
    expect(register).not.toHaveBeenCalled(); expect(rotate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("hydrates the shell environment before invoking project operations", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("REDIS_URL", undefined);
    vi.stubEnv("EXCUBITOR_AGENT_TOKEN", "fixture-agent-token");
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ source: "vault", secrets: {
      DATABASE_URL: "postgres://resolved/db", REDIS_URL: "redis://resolved",
    } }));
    const selected = operation === "register" ? register : rotate;
    selected.mockImplementationOnce(async () => {
      expect(process.env.DATABASE_URL).toBe("postgres://resolved/db");
      expect(process.env.REDIS_URL).toBe("redis://resolved");
      return credentials;
    });
    expect((await runCredentialCommand(operation, argv)).exitCode).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not invoke project operations after secret-agent failure", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("EXCUBITOR_AGENT_TOKEN", "fixture-agent-token");
    vi.mocked(fetch).mockResolvedValueOnce(new Response("private-response", { status: 403 }));
    expect(await runCredentialCommand(operation, argv)).toEqual({
      exitCode: 1, message: "script-env: keys_not_bound [DATABASE_URL]",
    });
    expect(register).not.toHaveBeenCalled(); expect(rotate).not.toHaveBeenCalled();
  });
});

it("parses explicit Vault scope and prefix, rejects unknown or empty flags", () => {
  expect(parseCredentialArgs("rotate", ["--project", "aedilis", "--service", "excubitor", "--vault-project", "project/one", "--env-prefix", "EXCUBITOR"]))
    .toEqual({ input: "aedilis", target: { service: "excubitor", project: "project/one", prefix: "EXCUBITOR" } });
  expect(() => parseCredentialArgs("rotate", ["--project", "aedilis", "--service", "excubitor", "--vault-project", ""]))
    .toThrow();
  expect(() => parseCredentialArgs("rotate", ["--unknown", "value"])).toThrow();
});
