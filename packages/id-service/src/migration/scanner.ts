/**
 * Id Service — マイグレーションスキャナー
 *
 * Git リポジトリを解析し、既存のスキーマ定義を検出して
 * コア ID フィールド vs サービス固有フィールドを自動分類する。
 * 検出結果からマイグレーション設定ファイルを生成する。
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import path from "path";

// ─── Types ─────────────────────────────────────────────────

export interface DetectedSchema {
  /** スキーマファイルのパス */
  filePath: string;
  /** 使用している ORM/ツール */
  orm: "drizzle" | "prisma" | "typeorm" | "unknown";
  /** 検出されたユーザーテーブル名 */
  tableName: string;
  /** 検出された全フィールド */
  fields: DetectedField[];
}

export interface DetectedField {
  name: string;
  /** DB カラム名 (検出可能な場合) */
  columnName?: string;
  type: string;
  nullable: boolean;
  /** コアID フィールドかどうかの自動判定 */
  classification: "core" | "service-specific" | "unknown";
  /** 判定理由 */
  reason: string;
}

export interface MigrationConfig {
  /** 対象リポジトリパス */
  repoPath: string;
  /** 検出された ORM */
  orm: string;
  /** 検出されたスキーマファイル */
  schemaFile: string;
  /** サービスID (リポジトリ名から推定) */
  serviceId: string;
  /** サービス名 */
  serviceName: string;
  /** コア ID フィールド */
  coreFields: string[];
  /** サービス固有フィールド → プラグインプロフィールに移動 */
  serviceFields: Array<{
    name: string;
    type: string;
    required: boolean;
  }>;
  /** 検出日時 */
  detectedAt: string;
}

// ─── Core ID Field Patterns (自動判定用) ───────────────────

const CORE_FIELD_PATTERNS: Record<string, RegExp[]> = {
  id: [/^id$/i],
  name: [/^name$/i, /^user_?name$/i, /^display_?name$/i],
  email: [/^email$/i, /^e_?mail$/i],
  role: [/^role$/i, /^user_?role$/i],
  passwordHash: [/^password/i, /^pw_?hash$/i, /^hashed_?password$/i],
  googleId: [/^google_?id$/i, /^google_?sub$/i],
  googleAccessToken: [/^google_?access_?token$/i],
  googleRefreshToken: [/^google_?refresh_?token$/i],
  googleTokenExpiresAt: [/^google_?token_?expires/i],
  googleScopes: [/^google_?scopes?$/i],
  lastLoginAt: [/^last_?login/i],
  createdAt: [/^created_?at$/i, /^created_?date$/i],
  updatedAt: [/^updated_?at$/i, /^updated_?date$/i, /^modified_?at$/i],
};

// ─── User Table Detection Patterns ─────────────────────────

const USER_TABLE_PATTERNS = [
  /users?\s*=/,
  /["']users?["']/,
  /table\s*\(\s*["']users?["']/,
  /model\s+User\s/,
  /@Entity\s*\(\s*["']users?["']\)/,
];

// ─── Scanner ───────────────────────────────────────────────

export class RepoScanner {
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = path.resolve(repoPath);
  }

  /**
   * リポジトリをスキャンしてスキーマ情報を検出
   */
  scan(): DetectedSchema[] {
    console.log(`[id-service:scanner] スキャン開始: ${this.repoPath}`);

    const schemas: DetectedSchema[] = [];

    // 1. ORM 検出
    const orm = this.detectOrm();
    console.log(`[id-service:scanner] 検出された ORM: ${orm}`);

    // 2. スキーマファイルを検索
    const schemaFiles = this.findSchemaFiles(orm);
    console.log(`[id-service:scanner] 検出されたスキーマファイル: ${schemaFiles.length} 件`);

    // 3. 各ファイルからユーザーテーブルを検出
    for (const file of schemaFiles) {
      const detected = this.parseSchemaFile(file, orm);
      if (detected) {
        schemas.push(detected);
      }
    }

    return schemas;
  }

  /**
   * スキャン結果からマイグレーション設定を生成
   */
  generateConfig(schemas: DetectedSchema[]): MigrationConfig | null {
    if (schemas.length === 0) {
      console.log("[id-service:scanner] ユーザースキーマが検出されませんでした");
      return null;
    }

    const schema = schemas[0]; // 最初に検出されたものを使用
    const repoName = path.basename(this.repoPath).toLowerCase();

    const coreFields: string[] = [];
    const serviceFields: Array<{ name: string; type: string; required: boolean }> = [];

    for (const field of schema.fields) {
      if (field.classification === "core") {
        coreFields.push(field.name);
      } else {
        serviceFields.push({
          name: field.name,
          type: field.type,
          required: !field.nullable,
        });
      }
    }

    return {
      repoPath: this.repoPath,
      orm: schema.orm,
      schemaFile: schema.filePath,
      serviceId: repoName,
      serviceName: repoName.charAt(0).toUpperCase() + repoName.slice(1),
      coreFields,
      serviceFields,
      detectedAt: new Date().toISOString(),
    };
  }

  /**
   * マイグレーション設定をファイルに出力
   */
  writeConfig(config: MigrationConfig, outputPath?: string): string {
    const outFile = outputPath ?? path.join(this.repoPath, "id-service.config.json");
    writeFileSync(outFile, JSON.stringify(config, null, 2), "utf-8");
    console.log(`[id-service:scanner] 設定ファイル出力: ${outFile}`);
    return outFile;
  }

  // ─── Private Methods ──────────────────────────────────

  /**
   * package.json から ORM を検出
   */
  private detectOrm(): "drizzle" | "prisma" | "typeorm" | "unknown" {
    const pkgPath = path.join(this.repoPath, "package.json");
    if (!existsSync(pkgPath)) return "unknown";

    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (allDeps["drizzle-orm"] || allDeps["drizzle-kit"]) return "drizzle";
      if (allDeps["prisma"] || allDeps["@prisma/client"]) return "prisma";
      if (allDeps["typeorm"]) return "typeorm";
    } catch {
      // parse error
    }

    return "unknown";
  }

  /**
   * ORM に応じたスキーマファイルを検索
   */
  private findSchemaFiles(orm: string): string[] {
    const files: string[] = [];

    switch (orm) {
      case "drizzle":
        this.walkDir(this.repoPath, (filePath: string) => {
          if (filePath.match(/schema\.(ts|js)$/) && !filePath.includes("node_modules")) {
            files.push(filePath);
          }
        });
        break;
      case "prisma":
        this.walkDir(this.repoPath, (filePath: string) => {
          if (filePath.endsWith("schema.prisma") && !filePath.includes("node_modules")) {
            files.push(filePath);
          }
        });
        break;
      case "typeorm":
        this.walkDir(this.repoPath, (filePath: string) => {
          if (filePath.match(/entity.*\.(ts|js)$/i) && !filePath.includes("node_modules")) {
            files.push(filePath);
          }
        });
        break;
      default:
        // フォールバック: schema を含むファイルを探す
        this.walkDir(this.repoPath, (filePath: string) => {
          if (filePath.match(/schema\.(ts|js|prisma)$/) && !filePath.includes("node_modules")) {
            files.push(filePath);
          }
        });
    }

    return files;
  }

  /**
   * スキーマファイルを解析してユーザーテーブルを検出
   */
  private parseSchemaFile(filePath: string, orm: string): DetectedSchema | null {
    const content = readFileSync(filePath, "utf-8");

    // ユーザーテーブルの有無を判定
    const hasUserTable = USER_TABLE_PATTERNS.some((p) => p.test(content));
    if (!hasUserTable) return null;

    console.log(`[id-service:scanner] ユーザーテーブル検出: ${filePath}`);

    const fields = this.extractFields(content, orm);

    return {
      filePath: path.relative(this.repoPath, filePath),
      orm: orm as DetectedSchema["orm"],
      tableName: "users",
      fields,
    };
  }

  /**
   * ファイル内容からフィールドを抽出
   */
  private extractFields(content: string, orm: string): DetectedField[] {
    const fields: DetectedField[] = [];

    switch (orm) {
      case "drizzle":
        this.extractDrizzleFields(content, fields);
        break;
      case "prisma":
        this.extractPrismaFields(content, fields);
        break;
      default:
        this.extractGenericFields(content, fields);
    }

    return fields;
  }

  /**
   * Drizzle スキーマからフィールド抽出
   */
  private extractDrizzleFields(content: string, fields: DetectedField[]): void {
    // users テーブル定義ブロックを抽出
    const tableMatch = content.match(
      /(?:export\s+(?:const|let)\s+)?users?\s*=\s*\w+Table\s*\(\s*["']users?["']\s*,\s*\{([\s\S]*?)\}\s*\)/,
    );
    if (!tableMatch) return;

    const tableBody = tableMatch[1];

    // フィールド行をパース: fieldName: text("column_name")...
    const fieldRegex = /(\w+)\s*:\s*(\w+)\s*\(\s*["']([^"']+)["']/g;
    let match;

    while ((match = fieldRegex.exec(tableBody)) !== null) {
      const fieldName = match[1];
      const fieldType = match[2];
      const columnName = match[3];

      // nullable 判定
      const fieldLine = tableBody.slice(match.index, tableBody.indexOf("\n", match.index + 1));
      const nullable = !fieldLine.includes(".notNull()");

      fields.push({
        name: fieldName,
        columnName,
        type: fieldType,
        nullable,
        ...this.classifyField(fieldName, columnName),
      });
    }
  }

  /**
   * Prisma スキーマからフィールド抽出
   */
  private extractPrismaFields(content: string, fields: DetectedField[]): void {
    const modelMatch = content.match(/model\s+User\s*\{([\s\S]*?)\}/);
    if (!modelMatch) return;

    const modelBody = modelMatch[1];
    const lines = modelBody.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("@@")) continue;

      const fieldMatch = trimmed.match(/^(\w+)\s+(\w+)(\??)/);
      if (!fieldMatch) continue;

      const fieldName = fieldMatch[1];
      const fieldType = fieldMatch[2];
      const nullable = !!fieldMatch[3];

      fields.push({
        name: fieldName,
        type: fieldType,
        nullable,
        ...this.classifyField(fieldName, fieldName),
      });
    }
  }

  /**
   * 汎用フィールド抽出 (TypeORM 等)
   */
  private extractGenericFields(content: string, fields: DetectedField[]): void {
    // @Column() や property definitions を探す
    const columnRegex = /@Column\s*\([^)]*\)\s*(\w+)\s*[?!]?\s*:\s*(\w+)/g;
    let match;

    while ((match = columnRegex.exec(content)) !== null) {
      const fieldName = match[1];
      const fieldType = match[2];

      fields.push({
        name: fieldName,
        type: fieldType,
        nullable: content.includes(`${fieldName}?`),
        ...this.classifyField(fieldName, fieldName),
      });
    }
  }

  /**
   * フィールド名からコア/サービス固有を分類
   */
  private classifyField(
    fieldName: string,
    columnName: string,
  ): { classification: DetectedField["classification"]; reason: string } {
    for (const [coreField, patterns] of Object.entries(CORE_FIELD_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(fieldName) || pattern.test(columnName)) {
          return { classification: "core", reason: `コアフィールド "${coreField}" にマッチ` };
        }
      }
    }

    return {
      classification: "service-specific",
      reason: "コアIDパターンに該当しないためサービス固有と判定",
    };
  }

  /**
   * ディレクトリを再帰走査
   */
  private walkDir(dir: string, callback: (filePath: string) => void, depth = 0): void {
    if (depth > 5) return; // 深すぎる場合はスキップ

    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
        const fullPath = path.join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            this.walkDir(fullPath, callback, depth + 1);
          } else if (stat.isFile()) {
            callback(fullPath);
          }
        } catch {
          // permission error or broken symlink
        }
      }
    } catch {
      // permission error
    }
  }
}

/**
 * リポジトリをスキャンしてマイグレーション設定を生成する便利関数
 */
export function scanAndGenerateConfig(repoPath: string): MigrationConfig | null {
  const scanner = new RepoScanner(repoPath);
  const schemas = scanner.scan();

  if (schemas.length === 0) return null;

  const config = scanner.generateConfig(schemas);
  if (config) {
    scanner.writeConfig(config);
  }

  return config;
}
