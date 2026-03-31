/**
 * JWT Secret 解決ヘルパー
 */

import type { IdSecretManager } from "./types.js";

const DEV_SECRET = "schedula-dev-secret-change-in-production";

export function resolveJwtSecret(secretManager: IdSecretManager): string {
  const nodeEnv = secretManager.getOrDefault("NODE_ENV", "development");
  const secret = secretManager.get("JWT_SECRET");
  if (secret) return secret;

  if (nodeEnv === "production") {
    console.error("[FATAL] JWT_SECRET is required in production");
    process.exit(1);
  }

  console.warn(
    "[WARNING] JWT_SECRET is not set. Using development default. DO NOT use in production.",
  );
  return DEV_SECRET;
}
