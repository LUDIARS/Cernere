import { resolveAgentEndpoint, resolveAgentToken } from "./agent-endpoint.js";
import { missingScriptEnv } from "./missing-script-env.js";
import { ScriptEnvError, type ScriptEnvErrorCode, type ScriptEnvKey } from "./script-env-error.js";

export const PROJECT_SCRIPT_ENV = ["DATABASE_URL", "REDIS_URL"] as const;
export const DATABASE_SCRIPT_ENV = ["DATABASE_URL"] as const;

interface ScriptEnvOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

const HTTP_ERRORS: Readonly<Record<number, ScriptEnvErrorCode>> = {
  401: "unauthorized", 403: "keys_not_bound", 404: "no_mapping", 502: "fetch_failed",
};

/** Called only by one-shot CLIs, before importing config or allocating DB/Redis pools. */
export async function ensureScriptEnv(required: readonly ScriptEnvKey[], options: ScriptEnvOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length === 0) return;
  const endpoint = resolveAgentEndpoint(env);
  const token = resolveAgentToken(env);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${endpoint}/api/v1/secrets/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ service: "cernere" }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ScriptEnvError("unreachable", missing);
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* Best-effort disposal; retain the HTTP category. */ }
    throw new ScriptEnvError(HTTP_ERRORS[response.status] ?? "http_error", missing);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ScriptEnvError("invalid_response", missing);
  }
  if (body === null || typeof body !== "object" || !("source" in body) || body.source !== "vault"
    || !("secrets" in body)) throw new ScriptEnvError("invalid_response", missing);
  // Compute after the request: env values injected while it was in flight also win.
  const additions = missingScriptEnv(env, body.secrets);
  const unresolved = required.filter((key) => !(env[key] ?? additions[key])?.trim());
  if (unresolved.length) throw new ScriptEnvError("missing_env", unresolved);
  Object.assign(env, additions);
}
