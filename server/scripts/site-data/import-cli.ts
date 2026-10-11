/**
 * Excubitor data-import hook body (launched by scripts/site/import-data.mjs).
 * `--input <abs> --sha256 <hex>`: verifies the bundle, preserves any existing database as a
 * backup and restores into a fresh one (spec/plan/2026-10-11-aws-site-migration.md).
 */
import { DATABASE_SCRIPT_ENV, ensureScriptEnv } from "../env/script-env.js";
import { parseImportArgs } from "./cli-args.js";
import { importData } from "./import-data.js";
import { runSiteDataCli } from "./run-site-data-cli.js";
import { createSiteDataContext } from "./site-data-context.js";

runSiteDataCli("site-data-import", async () => {
  const { input, sha256 } = parseImportArgs(process.argv.slice(2));
  await ensureScriptEnv(DATABASE_SCRIPT_ENV);
  const result = await importData(input, sha256, createSiteDataContext(process.env));
  const backup = result.backup ? `; previous database kept as ${result.backup}` : "";
  return `imported ${result.tables} tables${backup}`;
});
