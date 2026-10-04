type Key = "DATABASE_URL" | "REDIS_URL";

export default {
  post: (result: unknown, required: readonly Key[], options?: { env?: NodeJS.ProcessEnv }): true | string =>
    (result === undefined && required.every((key) => Boolean((options?.env ?? process.env)[key]?.trim())))
    || "required script environment is missing",
  postThrow: (error: unknown): true | string => (error instanceof Error
    && /^script-env: (no_endpoint|no_token|unreachable|unauthorized|keys_not_bound|no_mapping|fetch_failed|http_error|invalid_response|missing_env)(?: \[(?:DATABASE_URL|REDIS_URL)(?:, (?:DATABASE_URL|REDIS_URL))*\])?$/.test(error.message))
    || "failure must contain only a fixed category and known key names",
};
