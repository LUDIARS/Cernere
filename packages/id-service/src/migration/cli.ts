#!/usr/bin/env node

/**
 * Id Service — マイグレーション CLI
 *
 * Usage:
 *   npx tsx packages/id-service/src/migration/cli.ts [repo-path]
 *   npm run id:scan [-- path/to/repo]
 *
 * 1. Git リポジトリを解析
 * 2. スキーマファイルからユーザーテーブルを検出
 * 3. コア ID vs サービス固有フィールドを自動分類
 * 4. id-service.config.json を生成
 */

import { RepoScanner, type MigrationConfig } from "./scanner.js";

function main() {
  const args = process.argv.slice(2);
  const repoPath = args[0] || process.cwd();

  console.log("═══════════════════════════════════════════════════");
  console.log("  @cernere/id-service — マイグレーションスキャナー");
  console.log("═══════════════════════════════════════════════════");
  console.log();

  const scanner = new RepoScanner(repoPath);
  const schemas = scanner.scan();

  if (schemas.length === 0) {
    console.log("⚠ ユーザースキーマが検出されませんでした。");
    console.log();
    console.log("以下を確認してください:");
    console.log("  - schema.ts / schema.prisma が存在するか");
    console.log("  - users テーブルが定義されているか");
    process.exit(1);
  }

  console.log();
  console.log(`✓ ${schemas.length} 件のスキーマファイルを検出`);

  for (const schema of schemas) {
    console.log();
    console.log(`─── ${schema.filePath} (${schema.orm}) ───`);
    console.log(`テーブル: ${schema.tableName}`);
    console.log();

    const coreFields = schema.fields.filter((f) => f.classification === "core");
    const serviceFields = schema.fields.filter((f) => f.classification !== "core");

    console.log(`  コア ID フィールド (${coreFields.length} 件):`);
    for (const f of coreFields) {
      console.log(`    ✓ ${f.name} (${f.type}${f.nullable ? ", nullable" : ""}) — ${f.reason}`);
    }

    if (serviceFields.length > 0) {
      console.log();
      console.log(`  サービス固有フィールド (${serviceFields.length} 件):`);
      for (const f of serviceFields) {
        console.log(`    → ${f.name} (${f.type}${f.nullable ? ", nullable" : ""}) — ${f.reason}`);
      }
    }
  }

  // 設定ファイル生成
  const config = scanner.generateConfig(schemas);
  if (config) {
    const outFile = scanner.writeConfig(config);
    printConfig(config);
    console.log();
    console.log(`✓ 設定ファイルを生成しました: ${outFile}`);
    console.log();
    console.log("次のステップ:");
    console.log("  1. id-service.config.json を確認・編集");
    console.log("  2. サービス固有フィールドを ProfilePlugin として登録");
    console.log("  3. ユーザーテーブルからサービス固有フィールドを user_profiles に移行");
  }
}

function printConfig(config: MigrationConfig) {
  console.log();
  console.log("═══ 生成されたマイグレーション設定 ═══");
  console.log();
  console.log(`  サービスID:    ${config.serviceId}`);
  console.log(`  サービス名:    ${config.serviceName}`);
  console.log(`  ORM:           ${config.orm}`);
  console.log(`  スキーマ:      ${config.schemaFile}`);
  console.log(`  コアフィールド: [${config.coreFields.join(", ")}]`);

  if (config.serviceFields.length > 0) {
    console.log(`  サービス固有:`);
    for (const f of config.serviceFields) {
      console.log(`    - ${f.name}: ${f.type}${f.required ? " (required)" : ""}`);
    }
  }
}

main();
