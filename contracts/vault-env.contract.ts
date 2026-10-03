const required = [
  "DATABASE_URL", "REDIS_URL", "JWT_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
  "GITHUB_REDIRECT_URI", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "FRONTEND_URL",
];

export default {
  post: (): true | string => required.every((key) => Boolean(process.env[key]?.trim()))
    || "required injected environment is missing",
  postThrow: (error: unknown): true | string => {
    const missing = required.filter((key) => !process.env[key]?.trim());
    return (missing.length > 0 && error instanceof Error
      && error.message === `[env-bootstrap] missing Vault-injected env: ${missing.join(", ")}`)
      || "failure must list only missing environment names";
  },
};
