import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureEnv } from "../../src/lib/env-bootstrap.js";

const keys = ["DATABASE_URL", "REDIS_URL", "JWT_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
  "GITHUB_REDIRECT_URI", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "FRONTEND_URL"];

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Vault-only env bootstrap", () => {
  it("accepts injected env without network access or secret logging", async () => {
    keys.forEach((key) => vi.stubEnv(key, `private-${key}`));
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(ensureEnv()).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it.each(keys)("rejects missing %s by name even with legacy credentials present", async (missing) => {
    keys.forEach((key) => vi.stubEnv(key, "private-injected-value"));
    vi.stubEnv(missing, "");
    vi.stubEnv("INFISICAL_CLIENT_ID", "legacy-private-id");
    vi.stubEnv("INFISICAL_CLIENT_SECRET", "legacy-private-secret");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(ensureEnv()).rejects.toThrow(`[env-bootstrap] missing Vault-injected env: ${missing}`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects whitespace values and reports all missing names", async () => {
    keys.forEach((key) => vi.stubEnv(key, "  "));
    await expect(ensureEnv()).rejects.toThrow(`[env-bootstrap] missing Vault-injected env: ${keys.join(", ")}`);
  });
});
