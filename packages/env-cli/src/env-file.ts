/**
 * .env ファイルの読み書きユーティリティ
 */

import * as fs from "node:fs";
import type { InfisicalBootstrap } from "./types.js";

const DEFAULT_SITE_URL = "https://app.infisical.com";
const DEFAULT_ENVIRONMENT = "dev";

/**
 * .env 形式の文字列をパースして key-value に変換
 */
export function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

/**
 * .env.secrets から Infisical bootstrap を読み込む。
 * ファイルが無い or 必要なキーが揃っていなければ null。
 */
export function loadBootstrap(
  secretsPath: string,
  defaults?: { siteUrl?: string; environment?: string },
): InfisicalBootstrap | null {
  const siteUrlDefault = defaults?.siteUrl ?? DEFAULT_SITE_URL;
  const envDefault = defaults?.environment ?? DEFAULT_ENVIRONMENT;

  // 1. ファイルから
  if (fs.existsSync(secretsPath)) {
    const content = fs.readFileSync(secretsPath, "utf-8");
    const vars = parseEnvFile(content);
    if (vars.INFISICAL_PROJECT_ID && vars.INFISICAL_CLIENT_ID && vars.INFISICAL_CLIENT_SECRET) {
      return {
        siteUrl: vars.INFISICAL_SITE_URL || siteUrlDefault,
        projectId: vars.INFISICAL_PROJECT_ID,
        environment: vars.INFISICAL_ENVIRONMENT || envDefault,
        clientId: vars.INFISICAL_CLIENT_ID,
        clientSecret: vars.INFISICAL_CLIENT_SECRET,
      };
    }
  }

  // 2. 環境変数からフォールバック
  if (
    process.env.INFISICAL_PROJECT_ID &&
    process.env.INFISICAL_CLIENT_ID &&
    process.env.INFISICAL_CLIENT_SECRET
  ) {
    return {
      siteUrl: process.env.INFISICAL_SITE_URL || siteUrlDefault,
      projectId: process.env.INFISICAL_PROJECT_ID,
      environment: process.env.INFISICAL_ENVIRONMENT || envDefault,
      clientId: process.env.INFISICAL_CLIENT_ID,
      clientSecret: process.env.INFISICAL_CLIENT_SECRET,
    };
  }

  return null;
}

/**
 * Infisical bootstrap を .env.secrets に保存
 */
export function saveBootstrap(secretsPath: string, config: InfisicalBootstrap): void {
  const lines = [
    "# ─── Infisical Bootstrap Credentials ─────────────────────────",
    "# env-cli setup で自動生成。このファイルは .gitignore に含めること。",
    "# ─────────────────────────────────────────────────────────────",
    "",
    `INFISICAL_SITE_URL=${config.siteUrl}`,
    `INFISICAL_PROJECT_ID=${config.projectId}`,
    `INFISICAL_ENVIRONMENT=${config.environment}`,
    `INFISICAL_CLIENT_ID=${config.clientId}`,
    `INFISICAL_CLIENT_SECRET=${config.clientSecret}`,
    "",
  ];
  fs.writeFileSync(secretsPath, lines.join("\n"), "utf-8");
}
