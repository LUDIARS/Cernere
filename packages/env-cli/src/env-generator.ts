/**
 * .env ファイル生成ロジック
 */

import type { InfisicalBootstrap, RawSecret, EnvCliConfig } from "./types.js";

export interface EnvGeneratorResult {
  content: string;
  infraFromInfisical: number;
  infraFromDefaults: number;
  runtimeCount: number;
}

/**
 * Infisical のシークレットをもとに Docker 用 .env 文字列を生成する。
 *
 * 分類:
 *   - infraKeys にあるキー → .env に出力 (Docker が直接使用)
 *   - bootstrap 認証情報     → .env に出力 (サービスが SecretManager で使用)
 *   - それ以外               → コメントのみ (サービスがランタイムで取得)
 */
export function buildDotenv(
  secrets: RawSecret[],
  bootstrap: InfisicalBootstrap,
  config: EnvCliConfig,
): EnvGeneratorResult {
  const secretMap = new Map<string, string>();
  for (const s of secrets) {
    secretMap.set(s.secretKey, s.secretValue);
  }

  const infraKeys = config.infraKeys;

  const lines: string[] = [
    "# ═══════════════════════════════════════════════════════════════",
    `# ${config.name} — Docker 環境変数 (自動生成)`,
    `# Generated: ${new Date().toISOString()}`,
    `# Source: Infisical (${bootstrap.environment})`,
    "#",
    "# このファイルは env-cli env で再生成できます。",
    "# 手動編集しても次回の env 実行で上書きされます。",
    "# ═══════════════════════════════════════════════════════════════",
    "",
    "# ─── Infrastructure (Docker Compose 用) ──────────────────────",
  ];

  let infraFromInfisical = 0;
  for (const [key, defaultValue] of Object.entries(infraKeys)) {
    const fromInfisical = secretMap.get(key);
    const value = fromInfisical ?? defaultValue;
    lines.push(`${key}=${value}`);
    if (fromInfisical !== undefined) infraFromInfisical++;
  }
  const infraFromDefaults = Object.keys(infraKeys).length - infraFromInfisical;

  lines.push("");
  lines.push("# ─── Infisical Bootstrap (サービス用) ──────────────────────");
  lines.push("SECRETS_PROVIDER=infisical");
  lines.push(`INFISICAL_SITE_URL=${bootstrap.siteUrl}`);
  lines.push(`INFISICAL_PROJECT_ID=${bootstrap.projectId}`);
  lines.push(`INFISICAL_ENVIRONMENT=${bootstrap.environment}`);
  lines.push(`INFISICAL_CLIENT_ID=${bootstrap.clientId}`);
  lines.push(`INFISICAL_CLIENT_SECRET=${bootstrap.clientSecret}`);
  lines.push("");

  const runtimeKeys = secrets
    .map((s) => s.secretKey)
    .filter((k) => !(k in infraKeys));

  if (runtimeKeys.length > 0) {
    lines.push("# ─── Runtime Secrets (サービスが Infisical から自動取得) ──────");
    lines.push(`# 以下の ${runtimeKeys.length} 件はサービス内で SecretManager 経由で取得:`);
    for (const key of runtimeKeys) {
      lines.push(`#   ${key}`);
    }
    lines.push("");
  }

  return {
    content: lines.join("\n"),
    infraFromInfisical,
    infraFromDefaults,
    runtimeCount: runtimeKeys.length,
  };
}
