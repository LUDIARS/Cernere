import { SiteDataError } from "./site-data-error.js";

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const MAX_IDENTIFIER_LENGTH = 63;

/** Database names are interpolated into DDL, so only plain lowercase identifiers are accepted. */
export function assertDatabaseName(name: string): string {
  if (!SAFE_IDENTIFIER.test(name) || name.length > MAX_IDENTIFIER_LENGTH) {
    throw new SiteDataError("invalid_config", "database name must be a lowercase identifier");
  }
  return name;
}

export function quoteDatabaseName(name: string): string {
  return `"${assertDatabaseName(name)}"`;
}
