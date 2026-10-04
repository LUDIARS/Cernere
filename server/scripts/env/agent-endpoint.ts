import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveVaultEndpoint } from "../../src/project/vault-endpoint.js";
import { ScriptEnvError } from "./script-env-error.js";

export function resolveAgentEndpoint(env: NodeJS.ProcessEnv): string {
  try {
    return resolveVaultEndpoint({ ...env, EXCUBITOR_URL: env.EXCUBITOR_URL?.trim() });
  } catch {
    throw new ScriptEnvError("no_endpoint");
  }
}

/** Same precedence as Actio. An explicit unreadable/empty file must not fall back. */
export function resolveAgentToken(env: NodeJS.ProcessEnv): string {
  const injected = env.EXCUBITOR_AGENT_TOKEN?.trim();
  if (injected) return injected;
  const path = env.EXCUBITOR_AGENT_TOKEN_PATH?.trim()
    || join(env.APPDATA || join(homedir(), ".config"), "Excubitor", "secret-agent.token");
  try {
    const token = readFileSync(path, "utf8").trim();
    if (token) return token;
  } catch {
    // Filesystem errors include paths; publish only the fixed classification below.
  }
  throw new ScriptEnvError("no_token");
}
