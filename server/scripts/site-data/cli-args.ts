import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { SiteDataError } from "./site-data-error.js";

function parse(argv: readonly string[], names: readonly string[]): Record<string, string | undefined> {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: Object.fromEntries(names.map((name) => [name, { type: "string" as const }])),
      strict: true,
      allowPositionals: false,
    });
    return values as Record<string, string | undefined>;
  } catch {
    throw new SiteDataError("invalid_arguments", `expected ${names.map((n) => `--${n}`).join(" ")}`);
  }
}

function absolute(value: string | undefined, name: string): string {
  if (!value || !isAbsolute(value)) throw new SiteDataError("invalid_arguments", `--${name} must be an absolute path`);
  return value;
}

export function parseExportArgs(argv: readonly string[]): { output: string } {
  const values = parse(argv, ["output"]);
  return { output: absolute(values.output, "output") };
}

export function parseImportArgs(argv: readonly string[]): { input: string; sha256: string } {
  const values = parse(argv, ["input", "sha256"]);
  if (!values.sha256 || !/^[0-9a-f]{64}$/.test(values.sha256)) {
    throw new SiteDataError("invalid_arguments", "--sha256 must be 64 lowercase hex digits");
  }
  return { input: absolute(values.input, "input"), sha256: values.sha256 };
}
