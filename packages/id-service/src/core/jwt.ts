/**
 * JWT Secret 解決ヘルパー
 */

import { randomBytes } from "node:crypto";
import type { IdSecretManager } from "./types.js";

export function resolveJwtSecret(secretManager: IdSecretManager): string {
  const nodeEnv = secretManager.getOrDefault("NODE_ENV", "development");
  const secret = secretManager.get("JWT_SECRET");
  if (secret) return secret;

  if (nodeEnv === "production") {
    console.error("[FATAL] JWT_SECRET is required in production");
    process.exit(1);
  }

  // M-2: 既知のハードコード dev secret は設定ミス 1 つで認証バイパス級になる。
  // プロセス起動毎にランダム生成し、 dev 環境間で token を共有させない。
  console.warn(
    "[WARNING] JWT_SECRET is not set. Generated an ephemeral dev secret (tokens reset on restart). DO NOT rely on this in production.",
  );
  return randomBytes(32).toString("hex");
}
