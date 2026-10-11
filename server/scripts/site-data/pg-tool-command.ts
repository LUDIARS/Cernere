import { join } from "node:path";
import type { DatabaseTarget } from "./database-url.js";
import type { PgToolsConfig } from "./runtime-config.js";

export type PgTool = "pg_dump" | "pg_restore";

export interface ToolInvocation {
  command: string;
  args: string[];
  /** Extra environment for the child. The password travels here, never in argv. */
  env: Record<string, string>;
}

function connectionArgs(host: string, port: number, user: string, database: string): string[] {
  return ["--host", host, "--port", String(port), "--username", user, "--dbname", database, "--no-password"];
}

function toolArgs(tool: PgTool, target: DatabaseTarget, host: string, port: number, database: string): string[] {
  const connection = connectionArgs(host, port, target.user, database);
  return tool === "pg_dump"
    ? ["--format=custom", ...connection]
    // The importing site's role owns the restored objects; source ownership and grants (roles that
    // exist only on the source site) are not replicated.
    : ["--format=custom", "--no-owner", "--no-privileges", `--role=${target.user}`, "--exit-on-error", ...connection];
}

/** pg_dump writes the archive to stdout; pg_restore reads it from stdin. Both run without a shell. */
export function pgToolInvocation(tool: PgTool, config: PgToolsConfig, target: DatabaseTarget, database: string): ToolInvocation {
  const env: Record<string, string> = { PGPASSWORD: target.password };
  if (target.sslMode) env.PGSSLMODE = target.sslMode;
  if (config.mode === "host") {
    return {
      command: config.binDir ? join(config.binDir, tool) : tool,
      args: toolArgs(tool, target, target.host, target.port, database),
      env,
    };
  }
  // `-e NAME` without a value forwards the docker CLI's own environment value.
  const forwarded = Object.keys(env).flatMap((name) => ["-e", name]);
  return {
    command: config.docker,
    args: ["exec", "-i", ...forwarded, config.container, tool,
      ...toolArgs(tool, target, config.host ?? target.host, config.port ?? target.port, database)],
    env,
  };
}
