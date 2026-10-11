import { isAbsolute } from "node:path";
import { SiteDataError } from "./site-data-error.js";

/**
 * How pg_dump / pg_restore are reached on this site. SQL (counts, rename, create) always uses
 * DATABASE_URL from the host; only the dump tools differ because many sites lack host binaries.
 */
export type PgToolsConfig =
  | { mode: "host"; binDir?: string }
  | { mode: "docker"; docker: string; container: string; host?: string; port?: number };

/** Key inside EXCUBITOR_SERVICE_CONFIG_JSON. */
export const RUNTIME_CONFIG_KEY = "dataTransfer";
const DEFAULT_CONTAINER = "cernere-postgres";
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HOST_NAME = /^[A-Za-z0-9.:_-]{1,253}$/;

type Raw = Record<string, unknown>;

function invalid(field: string): never {
  throw new SiteDataError("invalid_config", `${RUNTIME_CONFIG_KEY}.${field}`);
}

function readRuntimeConfig(env: NodeJS.ProcessEnv): Raw {
  const json = env.EXCUBITOR_SERVICE_CONFIG_JSON?.trim();
  if (!json) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SiteDataError("invalid_config", "EXCUBITOR_SERVICE_CONFIG_JSON is not JSON");
  }
  const section = parsed !== null && typeof parsed === "object" ? (parsed as Raw)[RUNTIME_CONFIG_KEY] : undefined;
  if (section === undefined) return {};
  if (section === null || typeof section !== "object" || Array.isArray(section)) invalid("");
  return section as Raw;
}

function pick(env: NodeJS.ProcessEnv, envKey: string, raw: Raw, field: string): unknown {
  const fromEnv = env[envKey]?.trim();
  return fromEnv ? fromEnv : raw[field];
}

function optionalString(value: unknown, field: string, valid: (v: string) => boolean): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !valid(value)) invalid(field);
  return value;
}

function optionalPort(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const port = typeof value === "number" ? value : /^\d{1,5}$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid("port");
  return port;
}

/** Environment variables (`CERNERE_PG_*`) override the per-site runtime config field by field. */
export function resolvePgToolsConfig(env: NodeJS.ProcessEnv): PgToolsConfig {
  const raw = readRuntimeConfig(env);
  const mode = pick(env, "CERNERE_PG_TOOLS", raw, "pgTools") ?? "host";
  if (mode === "host") {
    const binDir = optionalString(pick(env, "CERNERE_PG_BIN_DIR", raw, "pgBinDir"), "pgBinDir", isAbsolute);
    return binDir ? { mode, binDir } : { mode };
  }
  if (mode !== "docker") invalid("pgTools");
  const docker = optionalString(pick(env, "CERNERE_PG_DOCKER", raw, "docker"), "docker",
    (v) => isAbsolute(v) || /^[A-Za-z0-9_.-]+$/.test(v)) ?? "docker";
  const container = optionalString(pick(env, "CERNERE_PG_CONTAINER", raw, "container"), "container",
    (v) => CONTAINER_NAME.test(v)) ?? DEFAULT_CONTAINER;
  const host = optionalString(pick(env, "CERNERE_PG_CONTAINER_HOST", raw, "host"), "host", (v) => HOST_NAME.test(v));
  const port = optionalPort(pick(env, "CERNERE_PG_CONTAINER_PORT", raw, "port"));
  return { mode, docker, container, ...(host ? { host } : {}), ...(port ? { port } : {}) };
}
