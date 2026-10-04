import { ScriptEnvError } from "./script-env-error.js";

/** Validate the whole response before computing a patch. Existing entries are immutable. */
export function missingScriptEnv(existing: NodeJS.ProcessEnv, received: unknown): Record<string, string> {
  if (received === null || typeof received !== "object" || Array.isArray(received)) {
    throw new ScriptEnvError("invalid_response");
  }
  const entries = Object.entries(received);
  if (entries.some(([key, value]) => !/^[A-Z_][A-Z0-9_]*$/.test(key)
    || typeof value !== "string" || value.includes("\0"))) {
    throw new ScriptEnvError("invalid_response");
  }
  return Object.fromEntries(entries.filter(([key]) => existing[key] === undefined)) as Record<string, string>;
}
