import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ToolInvocation } from "./pg-tool-command.js";
import { SiteDataError } from "./site-data-error.js";

const STDERR_TAIL_BYTES = 2048;
const active = new Set<ChildProcess>();

export interface RunToolOptions {
  /** Readable piped into the child's stdin (pg_restore). */
  stdin?: Readable;
  /** File descriptor receiving the child's stdout (pg_dump). */
  stdoutFd?: number;
  timeoutMs: number;
  /** Strings removed from diagnostics before they are printed. */
  redact: readonly string[];
}

/** Used by the CLI signal handlers so an interrupted run leaves no child behind. */
export function killActiveTools(): void {
  for (const child of active) child.kill("SIGKILL");
}

function redactText(text: string, secrets: readonly string[]): string {
  return secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join("***"), text);
}

export async function runTool(invocation: ToolInvocation, options: RunToolOptions): Promise<void> {
  const name = basename(invocation.command);
  if (options.timeoutMs <= 0) throw new SiteDataError("tool_timeout", name);
  const child = spawn(invocation.command, invocation.args, {
    shell: false,
    windowsHide: true,
    env: { ...process.env, ...invocation.env },
    stdio: [options.stdin ? "pipe" : "ignore", options.stdoutFd ?? "ignore", "pipe"],
  });
  active.add(child);
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs);
  const feeding = options.stdin && child.stdin
    // EPIPE after an early child exit is reported through the exit code instead.
    ? pipeline(options.stdin, child.stdin).catch(() => undefined)
    : Promise.resolve();
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    }).catch(() => { throw new SiteDataError("tool_failed", `${name} could not be started`); });
    await feeding;
    if (timedOut) throw new SiteDataError("tool_timeout", name);
    if (exitCode !== 0) {
      const tail = redactText(stderr, options.redact).trim();
      if (tail) console.error(`[site-data] ${name} stderr (tail):\n${tail}`);
      throw new SiteDataError("tool_failed", `${name} exit ${exitCode ?? "signal"}`);
    }
  } finally {
    clearTimeout(timer);
    active.delete(child);
  }
}
