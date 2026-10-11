import { assertDatabaseName } from "./identifiers.js";
import { SiteDataError } from "./site-data-error.js";

export interface DatabaseTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslMode?: string;
}

function parse(url: string): URL {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") return parsed;
  } catch {
    // The URL contains a password; never echo it.
  }
  throw new SiteDataError("invalid_config", "DATABASE_URL must be a postgres:// URL");
}

export function parseDatabaseUrl(url: string): DatabaseTarget {
  const parsed = parse(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(parsed.username);
  if (!parsed.hostname || !user) throw new SiteDataError("invalid_config", "DATABASE_URL needs host and user");
  return {
    host: parsed.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: parsed.port ? Number(parsed.port) : 5432,
    user,
    password: decodeURIComponent(parsed.password),
    database: assertDatabaseName(database),
    sslMode: parsed.searchParams.get("sslmode") ?? undefined,
  };
}

/** Same server and credentials, another database (maintenance `postgres` or a restore target). */
export function databaseUrlFor(url: string, database: string): string {
  const parsed = parse(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}
