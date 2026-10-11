export type SiteDataErrorCode =
  | "invalid_arguments" | "invalid_config" | "output_exists" | "input_invalid"
  | "sha256_mismatch" | "bundle_invalid" | "service_mismatch" | "format_unsupported"
  | "dump_sha256_mismatch" | "database_changed" | "tool_failed" | "tool_timeout"
  | "row_count_mismatch" | "restore_failed" | "rollback_failed";

/** Details carry only names, counts and exit codes; never connection strings or tool output with values. */
export class SiteDataError extends Error {
  constructor(readonly code: SiteDataErrorCode, detail?: string) {
    super(`site-data: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "SiteDataError";
  }
}

export function siteDataFailureMessage(error: unknown): string {
  if (error instanceof SiteDataError) return error.message;
  if (error instanceof Error && error.name === "ScriptEnvError") return error.message;
  return "site-data: operation failed; values are not displayed";
}
