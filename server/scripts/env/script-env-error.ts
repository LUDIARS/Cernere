export type ScriptEnvKey = "DATABASE_URL" | "REDIS_URL";
export type ScriptEnvErrorCode = "no_endpoint" | "no_token" | "unreachable" | "unauthorized"
  | "keys_not_bound" | "no_mapping" | "fetch_failed" | "http_error" | "invalid_response" | "missing_env";

/** Never attach response bodies, configuration values, or nested causes. */
export class ScriptEnvError extends Error {
  constructor(readonly code: ScriptEnvErrorCode, keys: readonly ScriptEnvKey[] = []) {
    super(`script-env: ${code}${keys.length ? ` [${keys.join(", ")}]` : ""}`);
    this.name = "ScriptEnvError";
  }
}

export function scriptFailureMessage(error: unknown): string {
  return error instanceof ScriptEnvError ? error.message : "Script operation failed; values are not displayed";
}
