import { describe, expect, it } from "vitest";
import { parseExportArgs, parseImportArgs } from "../../scripts/site-data/cli-args.js";
import { databaseUrlFor, parseDatabaseUrl } from "../../scripts/site-data/database-url.js";
import { pgToolInvocation } from "../../scripts/site-data/pg-tool-command.js";
import { resolvePgToolsConfig } from "../../scripts/site-data/runtime-config.js";
import { siteDataFailureMessage } from "../../scripts/site-data/site-data-error.js";

const URL_WITH_SECRET = "postgres://cernere:fixture-pass%40word@127.0.0.1:5433/cernere?sslmode=disable";
const abs = process.platform === "win32" ? "C:\\transfers\\cernere.bundle" : "/transfers/cernere.bundle";
const binDir = process.platform === "win32" ? "C:\\pg\\bin" : "/opt/pg/bin";

describe("database url", () => {
  it("parses the target and swaps only the database", () => {
    expect(parseDatabaseUrl(URL_WITH_SECRET)).toEqual({
      host: "127.0.0.1", port: 5433, user: "cernere", password: "fixture-pass@word", database: "cernere", sslMode: "disable",
    });
    expect(databaseUrlFor(URL_WITH_SECRET, "postgres"))
      .toBe("postgres://cernere:fixture-pass%40word@127.0.0.1:5433/postgres?sslmode=disable");
  });

  it("never echoes the URL in errors", () => {
    for (const url of ["mysql://u:fixture-secret@h/db", "postgres://u:fixture-secret@h/Bad-Name", "not a url fixture-secret"]) {
      let message = "";
      try { parseDatabaseUrl(url); } catch (error) { message = siteDataFailureMessage(error); }
      expect(message).toMatch(/^site-data: invalid_config/);
      expect(message).not.toContain("fixture-secret");
    }
  });
});

describe("pg tool configuration", () => {
  it("defaults to host tools on PATH", () => {
    expect(resolvePgToolsConfig({})).toEqual({ mode: "host" });
  });

  it("reads the Excubitor runtime config and lets env override per field", () => {
    const env = {
      EXCUBITOR_SERVICE_CONFIG_JSON: JSON.stringify({ dataTransfer: { pgTools: "docker", container: "infra-postgres-1", port: 5432 } }),
      CERNERE_PG_DOCKER: "docker.exe",
    };
    expect(resolvePgToolsConfig(env)).toEqual({ mode: "docker", docker: "docker.exe", container: "infra-postgres-1", port: 5432 });
    expect(resolvePgToolsConfig({ ...env, CERNERE_PG_CONTAINER: "cernere-postgres" })).toMatchObject({ container: "cernere-postgres" });
    expect(resolvePgToolsConfig({ CERNERE_PG_BIN_DIR: binDir })).toEqual({ mode: "host", binDir });
  });

  it.each([
    [{ CERNERE_PG_TOOLS: "ssh" }],
    [{ CERNERE_PG_TOOLS: "host", CERNERE_PG_BIN_DIR: "relative/bin" }],
    [{ CERNERE_PG_TOOLS: "docker", CERNERE_PG_CONTAINER: "bad name;rm" }],
    [{ CERNERE_PG_TOOLS: "docker", CERNERE_PG_CONTAINER_PORT: "99999" }],
    [{ EXCUBITOR_SERVICE_CONFIG_JSON: "{" }],
    [{ EXCUBITOR_SERVICE_CONFIG_JSON: JSON.stringify({ dataTransfer: [] }) }],
  ])("rejects invalid settings %j", (env) => {
    expect(() => resolvePgToolsConfig(env)).toThrow(/^site-data: invalid_config/);
  });

  it("keeps the password out of argv for host and docker", () => {
    const target = parseDatabaseUrl(URL_WITH_SECRET);
    const host = pgToolInvocation("pg_dump", { mode: "host" }, target, "cernere");
    expect(host.command).toBe("pg_dump");
    expect(host.args).toEqual(["--format=custom", "--host", "127.0.0.1", "--port", "5433", "--username", "cernere",
      "--dbname", "cernere", "--no-password"]);
    expect(host.env).toEqual({ PGPASSWORD: "fixture-pass@word", PGSSLMODE: "disable" });
    const docker = pgToolInvocation("pg_restore",
      { mode: "docker", docker: "docker", container: "cernere-postgres", port: 5432 }, target, "cernere");
    expect(docker.command).toBe("docker");
    expect(docker.args).toEqual(["exec", "-i", "-e", "PGPASSWORD", "-e", "PGSSLMODE", "cernere-postgres", "pg_restore",
      "--format=custom", "--no-owner", "--role=cernere", "--exit-on-error",
      "--host", "127.0.0.1", "--port", "5432", "--username", "cernere", "--dbname", "cernere", "--no-password"]);
    expect(JSON.stringify([host.args, docker.args])).not.toContain("fixture-pass");
  });
});

describe("cli arguments", () => {
  it("accepts absolute paths and a lowercase sha256", () => {
    expect(parseExportArgs(["--output", abs])).toEqual({ output: abs });
    expect(parseImportArgs(["--input", abs, "--sha256", "a".repeat(64)])).toEqual({ input: abs, sha256: "a".repeat(64) });
  });

  it.each([
    [["--output", "relative.bundle"]],
    [["--output", abs, "--extra"]],
    [[]],
  ])("rejects export arguments %j", (argv) => {
    expect(() => parseExportArgs(argv)).toThrow(/^site-data: invalid_arguments/);
  });

  it.each([
    [["--input", abs, "--sha256", "A".repeat(64)]],
    [["--input", "rel", "--sha256", "a".repeat(64)]],
    [["--input", abs]],
  ])("rejects import arguments %j", (argv) => {
    expect(() => parseImportArgs(argv)).toThrow(/^site-data: invalid_arguments/);
  });
});
