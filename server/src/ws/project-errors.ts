const VOLUPTAS_SURVEY_MODULE = "voluptas_survey";

export function publicProjectCommandError(
  module: string,
  error: unknown,
): string {
  if (module === VOLUPTAS_SURVEY_MODULE) {
    return "Voluptas survey command failed";
  }
  if (error instanceof Error && error.message) return error.message;
  return "Project command failed";
}
