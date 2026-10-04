import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureScriptEnv, PROJECT_SCRIPT_ENV } from "../../scripts/env/script-env.js";
import { missingScriptEnv } from "../../scripts/env/missing-script-env.js";
import { scriptFailureMessage } from "../../scripts/env/script-env-error.js";

const secrets = { DATABASE_URL: "postgres://fixture-secret/db", REDIS_URL: "redis://fixture-secret/cache" };
const configured = (): NodeJS.ProcessEnv => ({ EXCUBITOR_URL: "http://127.0.0.1:23456", EXCUBITOR_AGENT_TOKEN: "fixture-token" });
const reply = (values: unknown = secrets) => Response.json({ source: "vault", secrets: values });

afterEach(() => { vi.restoreAllMocks(); });

describe("script environment bootstrap", () => {
  it("requests the cernere binding and fills missing values before returning", async () => {
    const env = { ...configured(), DATABASE_URL: "postgres://existing/db" };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({ ...secrets, JWT_SECRET: "fixture-jwt" }));
    await ensureScriptEnv(PROJECT_SCRIPT_ENV, { env, fetch: fetcher });
    expect(env).toMatchObject({ DATABASE_URL: "postgres://existing/db", REDIS_URL: secrets.REDIS_URL, JWT_SECRET: "fixture-jwt" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:23456/api/v1/secrets/resolve", expect.objectContaining({
      method: "POST", body: JSON.stringify({ service: "cernere" }), redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: "Bearer fixture-token" },
      signal: expect.any(AbortSignal),
    }));
  });

  it("does nothing when the required environment is injected, without endpoint or token", async () => {
    const env = { ...secrets };
    const fetcher = vi.fn<typeof fetch>();
    await ensureScriptEnv(PROJECT_SCRIPT_ENV, { env, fetch: fetcher });
    expect(env).toEqual(secrets);
    expect(fetcher).not.toHaveBeenCalled();
    await ensureScriptEnv(["DATABASE_URL"], { env: { DATABASE_URL: secrets.DATABASE_URL }, fetch: fetcher });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves values added while a request is in flight", async () => {
    const env = configured();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      env.DATABASE_URL = "concurrent-existing-value";
      return reply();
    });
    await ensureScriptEnv(PROJECT_SCRIPT_ENV, { env, fetch: fetcher });
    expect(env.DATABASE_URL).toBe("concurrent-existing-value");
  });

  it.each(["", "  "])("does not overwrite an explicitly present invalid value %j", async (value) => {
    const env = { ...configured(), DATABASE_URL: value };
    await expect(ensureScriptEnv(PROJECT_SCRIPT_ENV, { env, fetch: vi.fn<typeof fetch>().mockResolvedValue(reply()) }))
      .rejects.toThrow("script-env: missing_env [DATABASE_URL]");
    expect(env).toEqual({ ...configured(), DATABASE_URL: value });
  });

  it("fails atomically if the binding does not supply all required keys", async () => {
    const env = configured();
    await expect(ensureScriptEnv(PROJECT_SCRIPT_ENV, {
      env, fetch: vi.fn<typeof fetch>().mockResolvedValue(reply({ DATABASE_URL: secrets.DATABASE_URL })),
    })).rejects.toThrow("script-env: missing_env [REDIS_URL]");
    expect(env).toEqual(configured());
  });

  it.each([[401, "unauthorized"], [403, "keys_not_bound"], [404, "no_mapping"], [502, "fetch_failed"], [500, "http_error"]])(
    "classifies HTTP %s without exposing its body", async (status, code) => {
      const env = configured();
      const response = new Response("response-secret fixture-token", { status: Number(status) });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const failure = await ensureScriptEnv(PROJECT_SCRIPT_ENV, {
        env, fetch: vi.fn<typeof fetch>().mockResolvedValue(response),
      }).catch((caught: unknown) => caught);
      expect(scriptFailureMessage(failure)).toBe(`script-env: ${code} [DATABASE_URL, REDIS_URL]`);
      expect(response.bodyUsed).toBe(true);
      expect(env).toEqual(configured());
      expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled(); expect(stderr).not.toHaveBeenCalled();
    },
  );

  it("sanitizes network errors including timeout/redirect errors and nested causes", async () => {
    const failure = await ensureScriptEnv(PROJECT_SCRIPT_ENV, {
      env: configured(), fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("fixture-token", { cause: secrets })),
    }).catch((caught: unknown) => caught);
    expect(scriptFailureMessage(failure)).toBe("script-env: unreachable [DATABASE_URL, REDIS_URL]");
    expect(failure).not.toHaveProperty("cause");
  });

  it.each([null, [], { source: "infisical", secrets }, { source: "vault" },
    { source: "vault", secrets: { DATABASE_URL: 123 } },
    { source: "vault", secrets: { ...secrets, "BAD=KEY": "response-secret" } },
    { source: "vault", secrets: { ...secrets, EXTRA: "nul\0value" } },
  ].map((body) => ({ body })))("rejects malformed responses atomically", async ({ body }) => {
    const env = configured();
    const failure = await ensureScriptEnv(PROJECT_SCRIPT_ENV, {
      env, fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)),
    }).catch((caught: unknown) => caught);
    expect(scriptFailureMessage(failure)).toMatch(/^script-env: invalid_response/);
    expect(env).toEqual(configured());
  });

  it("sanitizes JSON parse errors", async () => {
    await expect(ensureScriptEnv(PROJECT_SCRIPT_ENV, {
      env: configured(), fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("malformed-response-secret")),
    })).rejects.toThrow("script-env: invalid_response [DATABASE_URL, REDIS_URL]");
  });

  it("computes only missing entries without mutating either input", () => {
    const existing = Object.freeze({ DATABASE_URL: "existing", EMPTY: "" });
    const received = Object.freeze({ ...secrets, EMPTY: "replacement" });
    expect(missingScriptEnv(existing, received)).toEqual({ REDIS_URL: secrets.REDIS_URL });
    expect(existing.EMPTY).toBe("");
  });
});
