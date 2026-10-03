import { install } from "@ludiars/vestigium";
import { runCredentialCommand } from "./project-credential-command.js";
import type { CredentialOperation } from "./project-credential-args.js";

export async function credentialCli(operation: CredentialOperation): Promise<never> {
  const logging = install({ serviceCode: "cernere", captureConsole: true, pinoTransport: false });
  // Prevent DB debug callbacks from emitting nested database errors with credential material.
  process.env.CERNERE_DEV_LOG = "false";
  const result = await runCredentialCommand(operation, process.argv.slice(2));
  logging.writer.write({ level: result.exitCode === 0 ? "info" : "error", msg: result.message });
  (result.exitCode === 0 ? process.stdout : process.stderr).write(`${result.message}\n`);
  await logging.shutdown();
  // This one-shot operator owns imported DB/Redis pools; exit closes them on both paths.
  process.exit(result.exitCode);
}
