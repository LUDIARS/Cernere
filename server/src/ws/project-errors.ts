const VOLPUTAS_SURVEY_MODULE = "volputas_survey";

export function publicProjectCommandError(
  module: string,
  error: unknown,
): string {
  if (module === VOLPUTAS_SURVEY_MODULE) {
    return "Volputas survey command failed";
  }
  if (error instanceof Error && error.message) return error.message;
  return "Project command failed";
}
