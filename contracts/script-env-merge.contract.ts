type Env = Record<string, string | undefined>;

export default {
  post: (result: Env, existing: Env, received: unknown): true | string => {
    if (received === null || typeof received !== "object" || Array.isArray(received)) return "invalid environment response";
    const values = received as Record<string, unknown>;
    const missing = Object.keys(values).filter((key) => existing[key] === undefined);
    return (Object.keys(result).length === missing.length
      && missing.every((key) => result[key] === values[key])
      && Object.keys(result).every((key) => existing[key] === undefined))
      || "only undefined environment entries may be filled";
  },
  postThrow: (error: unknown): true | string => (error instanceof Error
    && error.message === "script-env: invalid_response") || "unsafe merge failure",
};
