/**
 * Excubitor data-export hook body (launched by scripts/site/export-data.mjs).
 * `--output <abs>`: dumps the stopped Cernere database into one bundle. Redis is not included.
 */
import { DATABASE_SCRIPT_ENV, ensureScriptEnv } from "../env/script-env.js";
import { parseExportArgs } from "./cli-args.js";
import { exportData } from "./export-data.js";
import { runSiteDataCli } from "./run-site-data-cli.js";
import { createSiteDataContext } from "./site-data-context.js";

runSiteDataCli("site-data-export", async () => {
  const { output } = parseExportArgs(process.argv.slice(2));
  await ensureScriptEnv(DATABASE_SCRIPT_ENV);
  const result = await exportData(output, createSiteDataContext(process.env));
  return `exported ${result.tables} tables (${result.dumpBytes} dump bytes)`;
});
