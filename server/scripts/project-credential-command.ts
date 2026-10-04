import { readFile } from "node:fs/promises";
import { parseCredentialArgs, type CredentialOperation } from "./project-credential-args.js";
import { saveProjectCredentials } from "../src/project/vault-credentials.js";
import { resolveAgentEndpoint } from "./env/agent-endpoint.js";
import type { DeliverProjectCredentials } from "../src/project/credential-delivery.js";
import { ensureScriptEnv, PROJECT_SCRIPT_ENV } from "./env/script-env.js";
import { ScriptEnvError } from "./env/script-env-error.js";

/** The CLI boundary returns only fixed messages, including on DB or JSON parse failures. */
export async function runCredentialCommand(operation: CredentialOperation, argv: string[]): Promise<{ exitCode: number; message: string }> {
  try {
    const { input, target } = parseCredentialArgs(operation, argv);
    resolveAgentEndpoint(process.env);
    const payload: unknown = operation === "register" ? JSON.parse(await readFile(input, "utf8")) : undefined;
    const deliver: DeliverProjectCredentials = (credentials) => saveProjectCredentials(credentials, target);
    await ensureScriptEnv(PROJECT_SCRIPT_ENV);
    process.env.CERNERE_DEV_LOG = "false";
    // Lazy import keeps argument/endpoint failures ahead of DB pool allocation.
    const { registerProject, rotateProjectSecret } = await import("../src/project/service.js");
    if (operation === "register") {
      const result = await registerProject(payload, undefined, deliver);
      if (!("clientSecret" in result)) return { exitCode: 0, message: "Project reactivated; existing credentials and Vault bindings unchanged" };
    } else {
      await rotateProjectSecret(input, deliver);
    }
    return { exitCode: 0, message: "Project credentials saved to Excubitor Vault and Cernere DB" };
  } catch (error) {
    if (error instanceof ScriptEnvError) return { exitCode: 1, message: error.message };
    return { exitCode: 1, message: "Project credential operation failed. Check CLI arguments, injected environment, Vault availability and DB state; values are not displayed." };
  }
}
