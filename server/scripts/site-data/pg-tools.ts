import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { ByteRange } from "./bundle-file.js";
import type { DatabaseTarget } from "./database-url.js";
import { pgToolInvocation } from "./pg-tool-command.js";
import { runTool } from "./process-runner.js";
import type { PgToolsConfig } from "./runtime-config.js";

export interface DumpTools {
  /** Writes a pg_dump custom archive of the configured database to a new file at `path`. */
  dumpTo(path: string): Promise<void>;
  /** Restores the archive bytes starting at `source.start` into `database`. */
  restoreFrom(database: string, source: ByteRange): Promise<void>;
}

export function createPgTools(config: PgToolsConfig, target: DatabaseTarget, remainingMs: () => number): DumpTools {
  const redact = [target.password];
  return {
    async dumpTo(path) {
      const handle = await open(path, "wx");
      try {
        await runTool(pgToolInvocation("pg_dump", config, target, target.database),
          { stdoutFd: handle.fd, timeoutMs: remainingMs(), redact });
      } finally {
        await handle.close();
      }
    },
    async restoreFrom(database, source) {
      await runTool(pgToolInvocation("pg_restore", config, target, database),
        { stdin: createReadStream(source.path, { start: source.start }), timeoutMs: remainingMs(), redact });
    },
  };
}
