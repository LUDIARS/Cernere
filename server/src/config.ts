/**
 * 環境変数設定
 */

function env(key: string, fallback?: string): string {
  const val = process.env[key];
  if (val !== undefined) return val;
  if (fallback !== undefined) return fallback;
  throw new Error(`Required environment variable ${key} is not set`);
}

function envBool(key: string, fallback = false): boolean {
  const val = process.env[key];
  if (!val) return fallback;
  return val === "true" || val === "1";
}

function isProduction(): boolean {
  const e = process.env.CERNERE_ENV ?? process.env.APP_ENV ?? "";
  return e === "production" || e === "prod";
}

export const config = {
  databaseUrl: env("DATABASE_URL", "postgres://cernere:cernere@localhost:5432/cernere"),
  redisUrl: env("REDIS_URL", "redis://127.0.0.1:6379"),
  listenPort: parseInt(env("LISTEN_PORT", "8080"), 10),
  frontendUrl: env("FRONTEND_URL", "http://localhost:5173"),

  // GitHub OAuth
  githubClientId: env("GITHUB_CLIENT_ID", ""),
  githubClientSecret: env("GITHUB_CLIENT_SECRET", ""),
  githubRedirectUri: env("GITHUB_REDIRECT_URI", "http://localhost:8080/auth/github/callback"),

  // Google OAuth
  googleClientId: env("GOOGLE_CLIENT_ID", ""),
  googleClientSecret: env("GOOGLE_CLIENT_SECRET", ""),
  googleRedirectUri: env("GOOGLE_REDIRECT_URI", "http://localhost:8080/auth/google/callback"),

  // JWT
  jwtSecret: (() => {
    const secret = process.env.JWT_SECRET;
    if (secret) return secret;
    if (isProduction()) {
      throw new Error("JWT_SECRET must be set in production environment");
    }
    console.warn("[config] JWT_SECRET is not set — using insecure default (dev only)");
    return "cernere-dev-secret-change-in-production";
  })(),

  // AWS MFA
  awsRegion: env("AWS_REGION", "ap-northeast-1"),
  awsSnsEnabled: envBool("AWS_SNS_ENABLED"),
  awsSesEnabled: envBool("AWS_SES_ENABLED"),
  awsSesFromEmail: env("AWS_SES_FROM_EMAIL", "noreply@example.com"),
  appName: env("APP_NAME", "Cernere"),

  isHttps: env("FRONTEND_URL", "http://localhost:5173").startsWith("https://"),
  isProduction: isProduction(),
} as const;
