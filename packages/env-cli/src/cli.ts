#!/usr/bin/env node
/**
 * env-cli — Infisical シークレット管理 CLI
 *
 * Usage:
 *   env-cli setup              対話形式で Infisical を設定
 *   env-cli test               接続テスト
 *   env-cli get <KEY>          シークレット取得
 *   env-cli list               シークレット一覧
 *   env-cli set <KEY> <VALUE>  シークレット作成/更新
 *   env-cli env                Infisical → .env 生成
 *   env-cli env --stdout       .env 内容を標準出力
 *
 * 設定ファイル:
 *   env-cli.config.{ts,js,json} — プロジェクト固有の設定
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import type { EnvCliConfig, InfisicalBootstrap, RawSecret } from "./types.js";
import { authenticate, fetchSecrets, getSecretByKey, upsertSecret } from "./infisical.js";
import { loadBootstrap, saveBootstrap } from "./env-file.js";
import { buildDotenv } from "./env-generator.js";
import { createPrompt } from "./prompt.js";

// ─── Config Loading ────────────────────────────────────────

const CONFIG_FILENAMES = [
  "env-cli.config.ts",
  "env-cli.config.js",
  "env-cli.config.mjs",
  "env-cli.config.json",
];

async function loadConfig(): Promise<EnvCliConfig> {
  const cwd = process.cwd();

  for (const filename of CONFIG_FILENAMES) {
    const filepath = path.join(cwd, filename);
    if (!fs.existsSync(filepath)) continue;

    if (filename.endsWith(".json")) {
      const content = fs.readFileSync(filepath, "utf-8");
      return JSON.parse(content) as EnvCliConfig;
    }

    // Dynamic import for .ts/.js/.mjs
    const mod = await import(pathToFileURL(filepath).toString()) as { default?: EnvCliConfig } & EnvCliConfig;
    return mod.default ?? mod;
  }

  // Default config (no infraKeys)
  console.error(
    `Warning: 設定ファイルが見つかりません (${CONFIG_FILENAMES.join(" / ")})`,
  );
  console.error("  デフォルト設定で実行します。");
  console.error("");

  return {
    name: path.basename(cwd),
    infraKeys: {},
  };
}

// ─── Resolved paths ────────────────────────────────────────

function resolveSecretsPath(config: EnvCliConfig): string {
  return config.secretsPath ?? path.join(process.cwd(), ".env.secrets");
}

function resolveDotenvPath(config: EnvCliConfig): string {
  return config.dotenvPath ?? path.join(process.cwd(), ".env");
}

// ─── Helpers ───────────────────────────────────────────────

function requireBootstrap(config: EnvCliConfig): InfisicalBootstrap {
  const secretsPath = resolveSecretsPath(config);
  const bootstrap = loadBootstrap(secretsPath, {
    siteUrl: config.defaultSiteUrl,
    environment: config.defaultEnvironment,
  });
  if (!bootstrap) {
    console.error("Error: Infisical が未設定です。先に setup を実行してください。");
    console.error("  env-cli setup");
    process.exit(1);
  }
  return bootstrap;
}

// ─── Commands ──────────────────────────────────────────────

async function cmdSetup(config: EnvCliConfig): Promise<void> {
  const secretsPath = resolveSecretsPath(config);
  const dotenvPath = resolveDotenvPath(config);
  const defaultSiteUrl = config.defaultSiteUrl ?? "https://app.infisical.com";
  const defaultEnv = config.defaultEnvironment ?? "dev";

  console.log(`╔══════════════════════════════════════════════╗`);
  console.log(`║   ${config.name} — Infisical Setup`.padEnd(47) + "║");
  console.log(`╚══════════════════════════════════════════════╝`);
  console.log();

  const existing = loadBootstrap(secretsPath, {
    siteUrl: config.defaultSiteUrl,
    environment: config.defaultEnvironment,
  });
  if (existing) {
    console.log("既存の設定が見つかりました:");
    console.log(`  Site URL:    ${existing.siteUrl}`);
    console.log(`  Project ID:  ${existing.projectId}`);
    console.log(`  Environment: ${existing.environment}`);
    console.log(`  Client ID:   ${existing.clientId.slice(0, 8)}...`);
    console.log();
  }

  const prompt = createPrompt();

  try {
    const siteUrl = await prompt.ask("Infisical Site URL", existing?.siteUrl || defaultSiteUrl);
    const projectId = await prompt.ask("Project ID", existing?.projectId);
    if (!projectId) {
      console.error("Error: Project ID は必須です。");
      process.exit(1);
    }

    const environment = await prompt.ask("Environment", existing?.environment || defaultEnv);
    const clientId = await prompt.ask("Client ID (Universal Auth)", existing?.clientId);
    if (!clientId) {
      console.error("Error: Client ID は必須です。");
      process.exit(1);
    }

    const clientSecret = await prompt.askSecret("Client Secret");
    if (!clientSecret) {
      console.error("Error: Client Secret は必須です。");
      process.exit(1);
    }

    const bootstrap: InfisicalBootstrap = {
      siteUrl,
      projectId,
      environment,
      clientId,
      clientSecret,
    };

    console.log("\n接続テスト中...");
    let secrets: RawSecret[] = [];
    try {
      const token = await authenticate(bootstrap);
      secrets = await fetchSecrets(bootstrap, token);
      console.log(`✓ 接続成功 — ${secrets.length} 件のシークレットを確認`);
    } catch (err) {
      console.error(`✗ 接続失敗: ${err instanceof Error ? err.message : err}`);
      const proceed = await prompt.ask("設定を保存しますか? (y/N)", "N");
      if (proceed.toLowerCase() !== "y") {
        console.log("中断しました。");
        process.exit(1);
      }
    }

    saveBootstrap(secretsPath, bootstrap);
    console.log(`\n設定を保存しました: ${secretsPath}`);

    if (secrets.length > 0) {
      const genEnv = await prompt.ask("Docker 用 .env を生成しますか? (Y/n)", "Y");
      if (genEnv.toLowerCase() !== "n") {
        const result = buildDotenv(secrets, bootstrap, config);
        fs.writeFileSync(dotenvPath, result.content, "utf-8");
        console.log(`✓ ${dotenvPath} を生成しました。`);
      }
    }

    console.log("\n次のステップ:");
    console.log("  env-cli env    # .env 再生成");
    console.log("  env-cli list   # シークレット一覧");
  } finally {
    prompt.close();
  }
}

async function cmdTest(config: EnvCliConfig): Promise<void> {
  const bootstrap = requireBootstrap(config);

  console.log("接続テスト中...");
  console.log(`  Site URL:    ${bootstrap.siteUrl}`);
  console.log(`  Project ID:  ${bootstrap.projectId}`);
  console.log(`  Environment: ${bootstrap.environment}`);

  try {
    const token = await authenticate(bootstrap);
    console.log("✓ 認証成功");

    const secrets = await fetchSecrets(bootstrap, token);
    console.log(`✓ シークレット取得成功 — ${secrets.length} 件`);

    const secretKeys = new Set(secrets.map((s) => s.secretKey));
    const missingInfra = Object.keys(config.infraKeys).filter((k) => !secretKeys.has(k));
    if (missingInfra.length > 0) {
      console.log("\n  ℹ Infisical に未登録のインフラキー (デフォルト値を使用):");
      for (const key of missingInfra) {
        console.log(`    ${key} = ${config.infraKeys[key]}`);
      }
    }
  } catch (err) {
    console.error(`✗ 失敗: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

async function cmdGet(config: EnvCliConfig, key: string): Promise<void> {
  const bootstrap = requireBootstrap(config);

  try {
    const token = await authenticate(bootstrap);
    const value = await getSecretByKey(bootstrap, token, key);
    if (value === null) {
      console.error(`Error: シークレット "${key}" が見つかりません。`);
      process.exit(1);
    }
    process.stdout.write(value);
    if (process.stdout.isTTY) process.stdout.write("\n");
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

async function cmdList(config: EnvCliConfig): Promise<void> {
  const bootstrap = requireBootstrap(config);

  try {
    const token = await authenticate(bootstrap);
    const secrets = await fetchSecrets(bootstrap, token);

    if (secrets.length === 0) {
      console.log("シークレットが登録されていません。");
      return;
    }

    console.log(`\n${bootstrap.environment} 環境のシークレット (${secrets.length} 件):\n`);

    const maxKeyLen = Math.max(...secrets.map((s) => s.secretKey.length));
    for (const s of secrets) {
      const maskedValue =
        s.secretValue.length > 4
          ? s.secretValue.slice(0, 2) + "***" + s.secretValue.slice(-2)
          : "***";
      const tag = s.secretKey in config.infraKeys ? "  [infra]" : "";
      console.log(`  ${s.secretKey.padEnd(maxKeyLen)}  ${maskedValue}  (v${s.version})${tag}`);
    }

    console.log();
    console.log("  [infra] = Docker .env に出力されるインフラキー");
    console.log("  それ以外 = サービスが SecretManager 経由でランタイム取得");
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

async function cmdSet(config: EnvCliConfig, key: string, value: string): Promise<void> {
  const bootstrap = requireBootstrap(config);

  try {
    const token = await authenticate(bootstrap);
    await upsertSecret(bootstrap, token, key, value);
    console.log(`✓ シークレット "${key}" を設定しました。`);

    if (key in config.infraKeys) {
      console.log("  ℹ インフラキーが更新されました。.env を再生成してください:");
      console.log("    env-cli env");
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

async function cmdEnv(config: EnvCliConfig, toStdout: boolean): Promise<void> {
  const bootstrap = requireBootstrap(config);
  const dotenvPath = resolveDotenvPath(config);

  try {
    const token = await authenticate(bootstrap);
    const secrets = await fetchSecrets(bootstrap, token);

    const result = buildDotenv(secrets, bootstrap, config);

    if (toStdout) {
      process.stdout.write(result.content);
    } else {
      fs.writeFileSync(dotenvPath, result.content, "utf-8");
      console.log(`✓ ${dotenvPath} を生成しました。`);
      console.log(`  インフラキー: ${result.infraFromInfisical} 件 (Infisical) + ${result.infraFromDefaults} 件 (デフォルト)`);
      console.log(`  ランタイム:   ${result.runtimeCount} 件 (SecretManager が自動取得)`);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

// ─── Up: 4-mode Docker Compose launcher ──────────────────

type UpMode = "dev" | "prod" | "standalone" | "standalone-dev";

const UP_MODES: Record<UpMode, { description: string; files: string[]; profile: string | null }> = {
  "dev":             { description: "開発 (ホットリロード, 外部 DB)",   files: ["docker-compose.yaml"], profile: "dev" },
  "prod":            { description: "本番 (ビルド済み, 外部 DB)",      files: ["docker-compose.yaml"], profile: null },
  "standalone":      { description: "All-in-One 本番 (DB 内蔵)",      files: ["docker-compose.yaml", "docker-compose.standalone.yaml"], profile: null },
  "standalone-dev":  { description: "All-in-One 開発 (DB 内蔵 + HR)", files: ["docker-compose.yaml", "docker-compose.standalone.yaml"], profile: "dev" },
};

async function cmdUp(config: EnvCliConfig, mode: UpMode, extraArgs: string[]): Promise<void> {
  const bootstrap = requireBootstrap(config);
  const dotenvPath = resolveDotenvPath(config);
  const dotenvExisted = fs.existsSync(dotenvPath);
  const modeConfig = UP_MODES[mode];

  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  ${config.name} — ${modeConfig.description}`.padEnd(47) + "║");
  console.log(`╚══════════════════════════════════════════════╝`);

  try {
    // 1. Infisical → .env 生成
    console.log("\nInflsical から .env を生成中...");
    const token = await authenticate(bootstrap);
    const secrets = await fetchSecrets(bootstrap, token);
    const result = buildDotenv(secrets, bootstrap, config);
    fs.writeFileSync(dotenvPath, result.content, "utf-8");
    console.log(`✓ ${dotenvPath} を生成しました (一時ファイル)`);

    // 2. docker compose コマンドを組み立て
    const fileArgs = modeConfig.files.flatMap((f) => ["-f", f]);
    const profileArgs = modeConfig.profile ? ["--profile", modeConfig.profile] : [];
    const defaultArgs = extraArgs.length > 0 ? extraArgs : ["-d"];
    const args = ["compose", ...fileArgs, ...profileArgs, "up", ...defaultArgs];

    // Windows Docker Desktop: amd64 を強制
    const env = { ...process.env };
    if (process.platform === "win32" && !env.DOCKER_DEFAULT_PLATFORM) {
      env.DOCKER_DEFAULT_PLATFORM = "linux/amd64";
      console.log("  Platform: Windows → DOCKER_DEFAULT_PLATFORM=linux/amd64");
    }

    console.log(`\n$ docker ${args.join(" ")}\n`);

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn("docker", args, {
        stdio: "inherit",
        cwd: process.cwd(),
        env,
      });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });

    if (exitCode !== 0) {
      console.error(`\ndocker compose が終了コード ${exitCode} で失敗しました。`);
      process.exitCode = exitCode;
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    // 3. .env を削除
    if (!dotenvExisted && fs.existsSync(dotenvPath)) {
      fs.unlinkSync(dotenvPath);
      console.log(`\n✓ ${dotenvPath} を削除しました (一時ファイル)`);
    } else if (dotenvExisted) {
      fs.unlinkSync(dotenvPath);
      console.log(`\n✓ ${dotenvPath} を削除しました`);
    }
  }
}

async function cmdInitialize(config: EnvCliConfig): Promise<void> {
  const bootstrap = requireBootstrap(config);

  console.log(`\n${config.name} — Infisical Initialization`);
  console.log(`環境: ${bootstrap.environment}`);
  console.log(`対象キー: ${Object.keys(config.infraKeys).length} 件\n`);

  try {
    const token = await authenticate(bootstrap);
    const existingSecrets = await fetchSecrets(bootstrap, token);
    const existingKeys = new Set(existingSecrets.map((s) => s.secretKey));

    let createdCount = 0;
    let skippedCount = 0;

    for (const [key, value] of Object.entries(config.infraKeys)) {
      if (existingKeys.has(key)) {
        console.log(`  SKIP: ${key} (既に存在します)`);
        skippedCount++;
        continue;
      }

      console.log(`  CREATE: ${key}...`);
      await upsertSecret(bootstrap, token, key, value);
      createdCount++;
    }

    console.log(`\n完了しました。`);
    console.log(`  新規作成: ${createdCount} 件`);
    console.log(`  スキップ: ${skippedCount} 件`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

// ─── Main ──────────────────────────────────────────────────

function printUsage(config: EnvCliConfig): void {
  console.log(`${config.name} — env-cli (Infisical シークレット管理)`);
  console.log();
  console.log("Usage:");
  console.log("  env-cli setup              対話形式で Infisical を設定");
  console.log("  env-cli test               接続テスト");
  console.log("  env-cli get <KEY>          シークレット取得");
  console.log("  env-cli list               シークレット一覧");
  console.log("  env-cli set <KEY> <VALUE>  シークレット作成/更新");
  console.log("  env-cli env                Infisical → .env 生成");
  console.log("  env-cli env --stdout       .env 内容を標準出力");
  console.log("  env-cli up [mode] [-- ..]   .env 生成 → docker compose up → .env 削除");
  console.log("    modes: dev (default)     開発 (ホットリロード, 外部 DB)");
  console.log("           prod              本番 (ビルド済み, 外部 DB)");
  console.log("           standalone        All-in-One 本番 (DB 内蔵)");
  console.log("           standalone-dev    All-in-One 開発 (DB 内蔵 + ホットリロード)");
  console.log("  env-cli initialize         config の infraKeys を Infisical に流し込む (未存在のみ)");
  console.log();
  console.log("フロー:");
  console.log("  1. setup      → Infisical 認証情報を .env.secrets に保存");
  console.log("  2. initialize → env-cli.config.ts のデフォルト値を Infisical に登録");
  console.log("  3. env        → Infisical から取得 → Docker 用 .env を生成");
  console.log("  4. up         → .env 一時生成 → docker compose up -d → .env 自動削除");
  console.log("  5. サービス内で SecretManager が残りのシークレットを取得");
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "setup":
      await cmdSetup(config);
      break;
    case "test":
      await cmdTest(config);
      break;
    case "initialize":
      await cmdInitialize(config);
      break;
    case "get":
      if (!args[0]) {
        console.error("Error: キーを指定してください。  env-cli get <KEY>");
        process.exit(1);
      }
      await cmdGet(config, args[0]);
      break;
    case "list":
      await cmdList(config);
      break;
    case "set":
      if (!args[0] || !args[1]) {
        console.error("Error: キーと値を指定してください。  env-cli set <KEY> <VALUE>");
        process.exit(1);
      }
      await cmdSet(config, args[0], args[1]);
      break;
    case "env":
      await cmdEnv(config, args.includes("--stdout"));
      break;
    case "up": {
      const validModes = ["dev", "prod", "standalone", "standalone-dev"] as const;
      const firstArg = args[0];
      let mode: UpMode = "dev";
      let restArgs = args;

      if (firstArg && validModes.includes(firstArg as UpMode)) {
        mode = firstArg as UpMode;
        restArgs = args.slice(1);
      }

      const dashDashIdx = restArgs.indexOf("--");
      const extraArgs = dashDashIdx >= 0 ? restArgs.slice(dashDashIdx + 1) : [];
      await cmdUp(config, mode, extraArgs);
      break;
    }
    default:
      printUsage(config);
      if (command && command !== "help" && command !== "--help" && command !== "-h") {
        process.exit(1);
      }
      break;
  }
}

await main();
