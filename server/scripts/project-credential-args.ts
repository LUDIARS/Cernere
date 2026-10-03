import { parseArgs } from "node:util";
import type { VaultTarget } from "../src/project/vault-credentials.js";

export type CredentialOperation = "register" | "rotate";

export function parseCredentialArgs(operation: CredentialOperation, argv: string[]): { input: string; target: VaultTarget } {
  const inputFlag = operation === "register" ? "file" : "project";
  const { values } = parseArgs({ args: argv, options: {
    [inputFlag]: { type: "string" },
    service: { type: "string" },
    "vault-project": { type: "string" },
    "env-prefix": { type: "string" },
  }, strict: true, allowPositionals: false });
  const input = values[inputFlag];
  const service = values.service;
  if (typeof input !== "string" || !input.trim() || typeof service !== "string" || !service.trim()) {
    throw new Error("Required CLI argument missing");
  }
  const project = values["vault-project"];
  const prefix = values["env-prefix"];
  if ((project !== undefined && (typeof project !== "string" || !project.trim()))
    || (prefix !== undefined && (typeof prefix !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(prefix)))) {
    throw new Error("Invalid Vault target argument");
  }
  return { input, target: { service, project: project as string | undefined, prefix: prefix as string | undefined } };
}
