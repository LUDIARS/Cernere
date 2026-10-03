/** Validate Excubitor Vault injection before importing config or opening resources. */
const REQUIRED_KEYS = [
  "DATABASE_URL", "REDIS_URL", "JWT_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
  "GITHUB_REDIRECT_URI", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "FRONTEND_URL",
] as const;

export async function ensureEnv(): Promise<void> {
  const missing = REQUIRED_KEYS.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`[env-bootstrap] missing Vault-injected env: ${missing.join(", ")}`);
  }
}
