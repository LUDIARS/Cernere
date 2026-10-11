import { parseDatabaseUrl } from "./database-url.js";
import { createPgTools, type DumpTools } from "./pg-tools.js";
import { resolvePgToolsConfig } from "./runtime-config.js";
import { SiteDataError } from "./site-data-error.js";
import { createSiteDatabase, type SiteDatabase } from "./site-database.js";

/** Excubitor stops the hook at 15 minutes; leave headroom for cleanup and rollback. */
export const TOOL_BUDGET_MS = 13 * 60_000;

export interface SiteDataContext {
  database: SiteDatabase;
  tools: DumpTools;
  databaseName: string;
  now: () => Date;
}

export function createSiteDataContext(env: NodeJS.ProcessEnv, startedAt = Date.now()): SiteDataContext {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new SiteDataError("invalid_config", "DATABASE_URL is not set");
  const target = parseDatabaseUrl(url);
  const deadline = startedAt + TOOL_BUDGET_MS;
  return {
    database: createSiteDatabase(url),
    tools: createPgTools(resolvePgToolsConfig(env), target, () => deadline - Date.now()),
    databaseName: target.database,
    now: () => new Date(),
  };
}
