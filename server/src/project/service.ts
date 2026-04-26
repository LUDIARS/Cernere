/**
 * プロジェクト管理ビジネスロジック
 *
 * WS コマンドから呼び出される。REST は公開しない。
 */

import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as dbSchema from "../db/schema.js";
import { config } from "../config.js";
import { AppError } from "../error.js";
import { projectDefinitionSchema, type ProjectDefinition } from "./schema.js";
import { migrateProjectSchema } from "./schema-migrator.js";
import * as cache from "./user-data-cache.js";
import { getAllProjectStatus, getProjectConnections, getProjectStatus } from "../ws/project-registry.js";

// ── Service Templates ────────────────────────────────────────

function getServiceDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "..", "server", "service"),
    path.resolve(process.cwd(), "service"),
    path.resolve("/app", "server", "service"),
  ];
  return candidates.find((d) => fs.existsSync(d)) ?? candidates[0];
}

/** 対応サービス一覧 (service/ 以下のディレクトリ名、_template 除外) */
export function listServiceTemplates(): Array<{ key: string; name: string; description: string }> {
  const dir = getServiceDir();
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter((d) => d !== "_template" && fs.statSync(path.join(dir, d)).isDirectory())
    .map((d) => {
      const schemaPath = path.join(dir, d, "schema.json");
      if (!fs.existsSync(schemaPath)) return null;
      try {
        const json = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
        return {
          key: json.project?.key ?? d,
          name: json.project?.name ?? d,
          description: json.project?.description ?? "",
        };
      } catch {
        return { key: d, name: d, description: "" };
      }
    })
    .filter(Boolean) as Array<{ key: string; name: string; description: string }>;
}

/** サービステンプレートの schema.json を取得 */
export function getServiceTemplate(key: string): ProjectDefinition {
  const dir = getServiceDir();
  const schemaPath = path.join(dir, key, "schema.json");

  if (!fs.existsSync(schemaPath)) {
    // _template をフォールバック
    const templatePath = path.join(dir, "_template", "schema.json");
    if (!fs.existsSync(templatePath)) {
      throw AppError.notFound(`Service template '${key}' not found`);
    }
    const json = JSON.parse(fs.readFileSync(templatePath, "utf-8"));
    return projectDefinitionSchema.parse(json);
  }

  const json = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  const parsed = projectDefinitionSchema.safeParse(json);
  if (!parsed.success) {
    throw AppError.internal(`Invalid template schema for '${key}': ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

// ── Project CRUD ─────────────────────────────────────────────

export async function listProjects() {
  const rows = await db.select({
    key: dbSchema.managedProjects.key,
    name: dbSchema.managedProjects.name,
    description: dbSchema.managedProjects.description,
    isActive: dbSchema.managedProjects.isActive,
    createdAt: dbSchema.managedProjects.createdAt,
  }).from(dbSchema.managedProjects);

  // 接続レジストリ (in-memory) から WS 接続状態をマージ
  const statusMap = getAllProjectStatus();
  return rows.map((p) => {
    const s = statusMap.get(p.key);
    return {
      ...p,
      connectionCount: s?.connectionCount ?? 0,
      lastConnectedAt: s?.lastConnectedAt ?? null,
      lastDisconnectedAt: s?.lastDisconnectedAt ?? null,
    };
  });
}

/**
 * 個別プロジェクトの WS 接続詳細 (admin 用).
 * connections: 現在 OPEN な接続を全件 (clientId / connectedAt 付き).
 */
export async function getProjectConnectionDetail(projectKey: string) {
  const proj = await db.select({ key: dbSchema.managedProjects.key })
    .from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, projectKey)).limit(1);
  if (proj.length === 0) throw AppError.notFound("Project not found");

  const status = getProjectStatus(projectKey);
  return {
    ...status,
    connections: getProjectConnections(projectKey).map((c) => ({
      connectionId: c.connectionId,
      clientId: c.clientId,
      connectedAt: c.connectedAt,
    })),
  };
}

export async function getProject(key: string) {
  const rows = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, key)).limit(1);
  if (rows.length === 0) throw AppError.notFound("Project not found");

  const p = rows[0];
  const def = p.schemaDefinition as ProjectDefinition;

  // カラムの module フィールドからモジュール別にグルーピング
  const columnsByModule: Record<string, Array<{ name: string; type: string; description?: string }>> = {};
  if (def?.user_data?.columns) {
    for (const [colName, col] of Object.entries(def.user_data.columns)) {
      const mod = col.module ?? "default";
      if (!columnsByModule[mod]) columnsByModule[mod] = [];
      columnsByModule[mod].push({ name: colName, type: col.type, description: col.description });
    }
  }

  return {
    key: p.key,
    name: p.name,
    description: p.description,
    clientId: p.clientId,
    schemaDefinition: p.schemaDefinition,
    columnsByModule,
    isActive: p.isActive,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export async function registerProject(payload: unknown, userId?: string) {
  let definition: ProjectDefinition;

  const parsed = projectDefinitionSchema.safeParse(payload);
  if (!parsed.success) {
    throw AppError.badRequest(`Invalid project definition: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
  }
  definition = parsed.data;

  // 既存チェック
  const existing = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, definition.project.key))
    .limit(1);

  if (existing.length > 0) {
    if (!existing[0].isActive) {
      await db.update(dbSchema.managedProjects).set({
        isActive: true,
        name: definition.project.name,
        description: definition.project.description,
        schemaDefinition: definition,
        updatedAt: new Date(),
      }).where(eq(dbSchema.managedProjects.key, definition.project.key));

      const result = await migrateProjectSchema(definition.project.key, definition);
      await saveDefinitionHistory(definition.project.key, definition, userId);
      return { message: "Project reactivated", key: definition.project.key, columnsAdded: result.columnsAdded };
    }
    throw AppError.conflict(`Project '${definition.project.key}' already exists`);
  }

  const clientId = `proj_${definition.project.key}_${crypto.randomUUID().slice(0, 8)}`;
  const clientSecret = crypto.randomUUID();
  const clientSecretHash = await bcrypt.hash(clientSecret, 12);

  await db.insert(dbSchema.managedProjects).values({
    key: definition.project.key,
    name: definition.project.name,
    description: definition.project.description,
    clientId,
    clientSecretHash,
    schemaDefinition: definition,
  });

  const result = await migrateProjectSchema(definition.project.key, definition);
  await saveDefinitionHistory(definition.project.key, definition, userId);

  return {
    message: "Project registered",
    key: definition.project.key,
    name: definition.project.name,
    clientId,
    clientSecret,
    tableCreated: result.created,
    columnsAdded: result.columnsAdded,
  };
}

export async function deleteProject(key: string) {
  const rows = await db.select({ key: dbSchema.managedProjects.key })
    .from(dbSchema.managedProjects).where(eq(dbSchema.managedProjects.key, key)).limit(1);
  if (rows.length === 0) throw AppError.notFound("Project not found");

  await db.update(dbSchema.managedProjects).set({
    isActive: false,
    updatedAt: new Date(),
  }).where(eq(dbSchema.managedProjects.key, key));

  return { message: "Project deactivated", key };
}

export async function updateProjectSchema(key: string, payload: unknown, userId?: string) {
  const rows = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, key)).limit(1);
  if (rows.length === 0) throw AppError.notFound("Project not found");

  const parsed = projectDefinitionSchema.safeParse(payload);
  if (!parsed.success) {
    throw AppError.badRequest(`Invalid definition: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
  }
  const definition = parsed.data;

  if (definition.project.key !== key) {
    throw AppError.badRequest("Project key in body does not match request key");
  }

  const result = await migrateProjectSchema(key, definition);

  const oldDef = rows[0].schemaDefinition as ProjectDefinition;
  const oldColumns = oldDef?.user_data?.columns ?? {};
  const newColumns = definition.user_data?.columns ?? {};

  // 新定義から消えたカラムは「論理削除」扱い (CLAUDE.md ルール: DROP しない)
  // 旧定義をマージして _deleted: true フラグを立てる
  for (const colName of Object.keys(oldColumns)) {
    if (!(colName in newColumns)) {
      if (!definition.user_data) definition.user_data = { columns: {} };
      definition.user_data.columns[colName] = {
        ...oldColumns[colName],
        _deleted: true,
      };
    }
  }

  await db.update(dbSchema.managedProjects).set({
    name: definition.project.name,
    description: definition.project.description,
    schemaDefinition: definition,
    updatedAt: new Date(),
  }).where(eq(dbSchema.managedProjects.key, key));

  await saveDefinitionHistory(key, definition, userId);
  await cache.invalidateProject(key);

  return { message: "Schema updated", key, columnsAdded: result.columnsAdded };
}

// ── Definition History ───────────────────────────────────────

async function saveDefinitionHistory(projectKey: string, definition: ProjectDefinition, userId?: string) {
  // 最新バージョン番号を取得
  const latest = await db.select({ version: dbSchema.projectDefinitionHistory.version })
    .from(dbSchema.projectDefinitionHistory)
    .where(eq(dbSchema.projectDefinitionHistory.projectKey, projectKey))
    .orderBy(desc(dbSchema.projectDefinitionHistory.version))
    .limit(1);

  const nextVersion = (latest[0]?.version ?? 0) + 1;

  await db.insert(dbSchema.projectDefinitionHistory).values({
    projectKey,
    definition,
    version: nextVersion,
    appliedBy: userId ?? null,
  });
}

export async function getDefinitionHistory(projectKey: string) {
  return db.select({
    id: dbSchema.projectDefinitionHistory.id,
    version: dbSchema.projectDefinitionHistory.version,
    definition: dbSchema.projectDefinitionHistory.definition,
    appliedBy: dbSchema.projectDefinitionHistory.appliedBy,
    createdAt: dbSchema.projectDefinitionHistory.createdAt,
  }).from(dbSchema.projectDefinitionHistory)
    .where(eq(dbSchema.projectDefinitionHistory.projectKey, projectKey))
    .orderBy(desc(dbSchema.projectDefinitionHistory.version));
}

// ── Module-level Opt-out ─────────────────────────────────────

export async function listModuleOptouts(userId: string, projectKey: string) {
  return db.select().from(dbSchema.userDataOptouts)
    .where(and(
      eq(dbSchema.userDataOptouts.userId, userId),
      eq(dbSchema.userDataOptouts.serviceId, projectKey),
    ));
}

/**
 * プロジェクト・モジュール単位のオプトアウト。
 * 1. userDataOptouts テーブルにレコード記録
 * 2. project_data_{key} の該当モジュールのカラムを NULL にクリア
 *    - 元の値は _deleted_columns JSONB に退避 (監査目的)
 */
export async function setModuleOptout(userId: string, projectKey: string, moduleKey: string) {
  const categoryKey = `module:${moduleKey}`;

  // 1. オプトアウト記録
  await db.insert(dbSchema.userDataOptouts).values({
    userId,
    serviceId: projectKey,
    categoryKey,
  }).onConflictDoNothing();

  // 2. 該当モジュールのデータを実削除 (NULL化 + _deleted_columns に退避)
  const projRows = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, projectKey)).limit(1);
  if (projRows.length === 0) {
    return { message: "Opted out (no project)", projectKey, moduleKey };
  }
  const definition = projRows[0].schemaDefinition as ProjectDefinition;
  const columns = definition.user_data?.columns ?? {};
  const moduleCols = Object.entries(columns)
    .filter(([, col]) => col.module === moduleKey && !col._deleted)
    .map(([name]) => name);

  if (moduleCols.length > 0 && /^[a-z][a-z0-9_]{1,62}$/.test(projectKey)) {
    const tableName = `project_data_${projectKey}`;
    const { default: postgres } = await import("postgres");
    const sqlClient = postgres(config.databaseUrl, { max: 1 });
    try {
      // 既存の _deleted_columns をマージして、該当カラムの値を退避してから NULL 化
      const selectCols = ["_deleted_columns", ...moduleCols]
        .map((c) => `"${c}"`).join(", ");
      const rows = await sqlClient.unsafe(
        `SELECT ${selectCols} FROM "${tableName}" WHERE user_id = $1`,
        [userId],
      );
      if (rows.length > 0) {
        const current = (rows[0]._deleted_columns ?? {}) as Record<string, unknown>;
        const backup: Record<string, unknown> = { ...current };
        for (const c of moduleCols) {
          if (rows[0][c] !== null && rows[0][c] !== undefined) {
            backup[c] = rows[0][c];
          }
        }

        // NULL 化 + _deleted_columns 更新
        const setClauses = moduleCols.map((c, i) => `"${c}" = NULL`);
        setClauses.push(`_deleted_columns = $${moduleCols.length + 1}`);
        setClauses.push(`updated_at = NOW()`);
        await sqlClient.unsafe(
          `UPDATE "${tableName}" SET ${setClauses.join(", ")} WHERE user_id = $${moduleCols.length + 2}`,
          [...moduleCols, JSON.stringify(backup), userId],
        );
      }
    } catch (err) {
      console.warn(`[optout] データ削除失敗 (${projectKey}/${moduleKey}):`, err);
    } finally {
      await sqlClient.end();
    }
  }

  await cache.invalidate(userId, projectKey);
  return { message: "Opted out", projectKey, moduleKey, deletedColumns: moduleCols };
}

export async function removeModuleOptout(userId: string, projectKey: string, moduleKey: string) {
  const categoryKey = `module:${moduleKey}`;
  await db.delete(dbSchema.userDataOptouts).where(and(
    eq(dbSchema.userDataOptouts.userId, userId),
    eq(dbSchema.userDataOptouts.serviceId, projectKey),
    eq(dbSchema.userDataOptouts.categoryKey, categoryKey),
  ));
  // 注: 削除済みのデータは復元しない (オプトアウト撤回後も以前のデータは戻らない)
  return { message: "Opt-out removed", projectKey, moduleKey };
}

// ── User Data per Project ───────────────────────────────────

/**
 * プロジェクトに保存されている自分のデータを取得する。
 * Data ページで「このプロジェクトが私のどんなデータを持っているか」を
 * ユーザーが確認するために使う。
 */
export interface UserProjectData {
  projectKey: string;
  projectName: string;
  schema: Record<string, { type: string; module?: string; description?: string }>;
  data: Record<string, unknown> | null;
}

export async function getUserProjectData(userId: string, projectKey: string): Promise<UserProjectData> {
  const cached = await cache.getCached<UserProjectData>(userId, projectKey);
  if (cached) return cached;

  const proj = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, projectKey)).limit(1);
  if (proj.length === 0) throw AppError.notFound("Project not found");

  const definition = proj[0].schemaDefinition as ProjectDefinition;
  const columns = definition.user_data?.columns ?? {};

  // 安全な識別子チェック (SQLインジェクション対策)
  if (!/^[a-zA-Z0-9_]+$/.test(projectKey)) {
    throw AppError.badRequest("Invalid project key");
  }
  const tableName = `project_data_${projectKey}`;

  // テーブルに保存されている自分のデータを取得
  let data: Record<string, unknown> | null = null;
  try {
    const rows = await db.execute(sql.raw(
      `SELECT * FROM ${tableName} WHERE user_id = '${userId.replace(/'/g, "''")}' LIMIT 1`,
    )) as unknown as Array<Record<string, unknown>> | { rows: Array<Record<string, unknown>> };
    const rowList = Array.isArray(data) ? data : (rows as { rows: Array<Record<string, unknown>> }).rows ?? rows;
    if (Array.isArray(rowList) && rowList.length > 0) {
      data = rowList[0];
    }
  } catch {
    // テーブル未作成等は無視して null を返す
    data = null;
  }

  const result: UserProjectData = {
    projectKey: proj[0].key,
    projectName: proj[0].name,
    schema: columns,
    data,
  };
  await cache.setCached(userId, projectKey, result);
  return result;
}

/**
 * ユーザーダッシュボード向け: ユーザーデータスキーマを持つプロジェクトの
 * 一覧を返す。"利用中" (inUse) はユーザーが 1 カラム以上の値を持つかで判定する。
 *
 * connectionCount / lastConnectedAt は project_credentials WS の生存状態を
 * 表す (ダッシュボードの「使用中」表示はこの値を優先する)。
 */
export interface UserProjectOverview {
  key: string;
  name: string;
  description: string;
  isActive: boolean;
  /** ユーザーデータカラム総数 (論理削除除く) */
  totalColumns: number;
  /** うち値がセットされているカラム数 */
  filledColumns: number;
  /** 利用中か (filledColumns > 0) */
  inUse: boolean;
  /** 現在 project_credentials で繋いでいる接続数 (Cernere プロセスローカル) */
  connectionCount: number;
  /** 直近に接続が確立したタイムスタンプ */
  lastConnectedAt: Date | null;
}

/**
 * 認証済みユーザー向けに、プロジェクトのフロントエンド URL と
 * authCode を発行する。フロントから別タブで開き、遷移先で
 * `/api/auth/exchange { code }` を叩いて accessToken に交換する想定。
 */
export async function issueProjectOpenUrl(userId: string, projectKey: string): Promise<{ url: string }> {
  const proj = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, projectKey)).limit(1);
  if (proj.length === 0) throw AppError.notFound("Project not found");
  if (!proj[0].isActive) throw AppError.badRequest("Project is inactive");

  const def = proj[0].schemaDefinition as ProjectDefinition;
  const frontendUrl = def?.endpoint?.frontend_url;
  if (!frontendUrl) throw AppError.badRequest("Project has no frontend_url configured");

  const { issueAuthCodeForUserId } = await import("../auth/auth-code.js");
  const authCode = await issueAuthCodeForUserId(userId);
  if (!authCode) throw AppError.forbidden("User not found");

  // ユーザ × プロジェクトの初回 "use" を確定: Cernere DB に空行を作る
  await ensureUserProjectRow(userId, projectKey);

  const separator = frontendUrl.includes("?") ? "&" : "?";
  const url = `${frontendUrl}${separator}code=${encodeURIComponent(authCode)}`;
  return { url };
}

export async function listUserProjectsOverview(userId: string): Promise<UserProjectOverview[]> {
  const projects = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.isActive, true));

  const overviews: UserProjectOverview[] = [];
  for (const proj of projects) {
    const definition = proj.schemaDefinition as ProjectDefinition;
    const columns = definition?.user_data?.columns ?? {};
    const activeColumns = Object.entries(columns).filter(([, col]) => !col._deleted);

    // ユーザーデータスキーマを持たないプロジェクトは表示対象外
    if (activeColumns.length === 0) continue;

    let filled = 0;
    try {
      const ud = await getUserProjectData(userId, proj.key);
      if (ud.data) {
        for (const [colName] of activeColumns) {
          const v = ud.data[colName];
          if (v !== null && v !== undefined && v !== "") filled++;
        }
      }
    } catch {
      // 個別プロジェクトの取得失敗はスキップ扱い
    }

    const status = getProjectStatus(proj.key);
    overviews.push({
      key: proj.key,
      name: proj.name,
      description: proj.description,
      isActive: proj.isActive,
      totalColumns: activeColumns.length,
      filledColumns: filled,
      inUse: filled > 0,
      connectionCount: status.connectionCount,
      lastConnectedAt: status.lastConnectedAt,
    });
  }
  return overviews;
}

/** 自分が有効化しているすべてのプロジェクトについて保持データを取得 */
export async function listAllUserProjectData(userId: string) {
  const projects = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.isActive, true));

  const result = [];
  for (const proj of projects) {
    try {
      const data = await getUserProjectData(userId, proj.key);
      result.push(data);
    } catch {
      // 個別プロジェクトの取得失敗はスキップ
    }
  }
  return result;
}

// ── プロジェクトクライアント向け User Data API ─────────────────
// Schedula 等の外部サービスが /ws/project 経由で呼び出す想定。
// 書き込みはカラム単位の opt-out 状況を判定し、オプトアウト中は拒否する。

/** 安全なテーブル名チェック */
function safeTableName(projectKey: string): string {
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(projectKey)) {
    throw AppError.badRequest("Invalid project key");
  }
  return `project_data_${projectKey}`;
}

/**
 * 「ユーザがそのプロジェクトを使い始めた」タイミングで
 * `project_data_<key>` に空行を確保する.
 *
 * トリガ:
 *   - Cernere ダッシュボードの「開く」 (issueProjectOpenUrl)
 *   - 各サービス側での composite 認証 (auth_session.projectKey が判明している場合)
 *
 * 既存行があれば NO-OP (ON CONFLICT DO NOTHING).
 * project が user_data スキーマを持たない場合や DB エラー時は warn のみで握り潰す
 * (本筋の認証フローを巻き込まないため).
 */
export async function ensureUserProjectRow(userId: string, projectKey: string): Promise<void> {
  let proj;
  try {
    proj = await db.select().from(dbSchema.managedProjects)
      .where(eq(dbSchema.managedProjects.key, projectKey)).limit(1);
  } catch (err) {
    console.warn(`[project-data] ensureUserProjectRow: project lookup failed (${projectKey}):`, err);
    return;
  }
  if (proj.length === 0 || !proj[0].isActive) return;

  const def = proj[0].schemaDefinition as ProjectDefinition;
  const columns = def?.user_data?.columns ?? {};
  const hasActive = Object.values(columns).some((c) => !c._deleted);
  if (!hasActive) return; // user_data 定義なし → row 不要

  const tableName = safeTableName(projectKey);
  const { default: postgres } = await import("postgres");
  const sqlClient = postgres(config.databaseUrl, { max: 1 });
  try {
    await sqlClient.unsafe(
      `INSERT INTO "${tableName}" (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
  } catch (err) {
    console.warn(`[project-data] ensureUserProjectRow failed (${projectKey}):`, err);
  } finally {
    await sqlClient.end();
  }
}

/** 安全なカラム名チェック */
function assertSafeColumn(name: string): void {
  if (!/^[a-z][a-z0-9_:]{0,127}$/i.test(name)) {
    throw AppError.badRequest(`Invalid column name: ${name}`);
  }
}

async function loadProjectColumns(
  projectKey: string,
): Promise<Record<string, { type: string; module?: string; _deleted?: boolean }>> {
  const proj = await db.select().from(dbSchema.managedProjects)
    .where(eq(dbSchema.managedProjects.key, projectKey)).limit(1);
  if (proj.length === 0) throw AppError.notFound("Project not found");
  const definition = proj[0].schemaDefinition as ProjectDefinition;
  return (definition.user_data?.columns ?? {}) as Record<string, {
    type: string; module?: string; _deleted?: boolean;
  }>;
}

/**
 * プロジェクトクライアント向け: 特定ユーザの指定カラムのみ取得。
 * columns 未指定または空配列なら全カラム返す。
 */
export async function getUserColumns(
  projectKey: string,
  userId: string,
  columns?: string[],
): Promise<Record<string, unknown>> {
  const tableName = safeTableName(projectKey);
  const schemaColumns = await loadProjectColumns(projectKey);

  const targetCols = (columns && columns.length > 0)
    ? columns.filter((c) => c in schemaColumns && !schemaColumns[c]._deleted)
    : Object.keys(schemaColumns).filter((c) => !schemaColumns[c]._deleted);

  for (const c of targetCols) assertSafeColumn(c);

  if (targetCols.length === 0) return {};

  const { default: postgres } = await import("postgres");
  const sqlClient = postgres(config.databaseUrl, { max: 1 });
  try {
    const selectCols = targetCols.map((c) => `"${c}"`).join(", ");
    const rows = await sqlClient.unsafe(
      `SELECT ${selectCols} FROM "${tableName}" WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    if (rows.length === 0) {
      // レコードなしなら全て null
      const empty: Record<string, unknown> = {};
      for (const c of targetCols) empty[c] = null;
      return empty;
    }
    const result: Record<string, unknown> = {};
    for (const c of targetCols) result[c] = rows[0][c] ?? null;
    return result;
  } catch (err) {
    console.warn(`[project-data] getUserColumns failed (${projectKey}):`, err);
    const empty: Record<string, unknown> = {};
    for (const c of targetCols) empty[c] = null;
    return empty;
  } finally {
    await sqlClient.end();
  }
}

/**
 * プロジェクトクライアント向け: 部分 upsert。
 * オプトアウト中のモジュールに属するカラムは書き込み拒否 (エラー)。
 */
export async function setUserData(
  projectKey: string,
  userId: string,
  data: Record<string, unknown>,
): Promise<{ ok: true; updated: string[] }> {
  const tableName = safeTableName(projectKey);
  const schemaColumns = await loadProjectColumns(projectKey);

  const targetCols = Object.keys(data).filter(
    (c) => c in schemaColumns && !schemaColumns[c]._deleted,
  );
  if (targetCols.length === 0) {
    throw AppError.badRequest("No valid columns to update");
  }

  // オプトアウトチェック: 各カラムの module が opt-out されていないか
  for (const c of targetCols) {
    const mod = schemaColumns[c].module;
    if (!mod) continue;
    if (await isOptedOut(userId, projectKey, mod)) {
      throw AppError.badRequest(
        `User has opted out of module "${mod}" for project "${projectKey}"`,
      );
    }
  }

  for (const c of targetCols) assertSafeColumn(c);

  const { default: postgres } = await import("postgres");
  const sqlClient = postgres(config.databaseUrl, { max: 1 });
  try {
    // INSERT ... ON CONFLICT DO UPDATE (upsert)
    const colList = ["user_id", ...targetCols].map((c) => `"${c}"`).join(", ");
    const placeholders = ["$1", ...targetCols.map((_, i) => `$${i + 2}`)].join(", ");
    const updateClause = targetCols
      .map((c) => `"${c}" = EXCLUDED."${c}"`)
      .concat([`updated_at = NOW()`])
      .join(", ");
    const values = [userId, ...targetCols.map((c) => {
      const v = data[c];
      // JSON 型の場合は stringify
      const isJson = schemaColumns[c].type === "json" || schemaColumns[c].type === "jsonb";
      return isJson ? JSON.stringify(v) : v;
    })];
    await sqlClient.unsafe(
      `INSERT INTO "${tableName}" (${colList}, created_at, updated_at)
       VALUES (${placeholders}, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET ${updateClause}`,
      values as never[],
    );
    await cache.invalidate(userId, projectKey);
    return { ok: true, updated: targetCols };
  } finally {
    await sqlClient.end();
  }
}

/** プロジェクトクライアント向け: 指定カラムを NULL にする (opt-out とは別) */
export async function deleteUserColumns(
  projectKey: string,
  userId: string,
  columns: string[],
): Promise<{ ok: true; deleted: string[] }> {
  const tableName = safeTableName(projectKey);
  const schemaColumns = await loadProjectColumns(projectKey);
  const targetCols = columns.filter(
    (c) => c in schemaColumns && !schemaColumns[c]._deleted,
  );
  if (targetCols.length === 0) return { ok: true, deleted: [] };

  for (const c of targetCols) assertSafeColumn(c);

  const { default: postgres } = await import("postgres");
  const sqlClient = postgres(config.databaseUrl, { max: 1 });
  try {
    const setClauses = targetCols.map((c) => `"${c}" = NULL`);
    setClauses.push(`updated_at = NOW()`);
    await sqlClient.unsafe(
      `UPDATE "${tableName}" SET ${setClauses.join(", ")} WHERE user_id = $1`,
      [userId],
    );
    await cache.invalidate(userId, projectKey);
    return { ok: true, deleted: targetCols };
  } finally {
    await sqlClient.end();
  }
}

/** ユーザーがオプトアウト中のモジュールか判定 */
export async function isOptedOut(userId: string, projectKey: string, moduleKey: string): Promise<boolean> {
  const rows = await db.select({ userId: dbSchema.userDataOptouts.userId })
    .from(dbSchema.userDataOptouts)
    .where(and(
      eq(dbSchema.userDataOptouts.userId, userId),
      eq(dbSchema.userDataOptouts.serviceId, projectKey),
      eq(dbSchema.userDataOptouts.categoryKey, `module:${moduleKey}`),
    )).limit(1);
  return rows.length > 0;
}

// ═══ OAuth Token Storage (project-owned) ══════════════════════════════
// 各プロジェクトは OAuth トークンを自前で保管せず Cernere に預ける。
// personal data rule (Schedula CLAUDE.md §個人データ保管禁止) の準拠基盤。

export interface OAuthTokenInput {
  provider: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: string | null;  // ISO 8601
  tokenType?: string | null;
  scope?: string | null;
  metadata?: Record<string, unknown>;
}

export interface OAuthTokenRecord {
  provider: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  tokenType: string | null;
  scope: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export async function storeOAuthToken(
  projectKey: string,
  userId: string,
  input: OAuthTokenInput,
): Promise<{ ok: true; provider: string }> {
  if (!input.provider) throw AppError.badRequest("provider is required");

  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  const now = new Date();

  const existing = await db.select()
    .from(dbSchema.projectOauthTokens)
    .where(and(
      eq(dbSchema.projectOauthTokens.projectKey, projectKey),
      eq(dbSchema.projectOauthTokens.userId, userId),
      eq(dbSchema.projectOauthTokens.provider, input.provider),
    )).limit(1);

  if (existing.length > 0) {
    await db.update(dbSchema.projectOauthTokens)
      .set({
        accessToken: input.accessToken ?? existing[0].accessToken,
        refreshToken: input.refreshToken ?? existing[0].refreshToken,
        expiresAt: expiresAt ?? existing[0].expiresAt,
        tokenType: input.tokenType ?? existing[0].tokenType,
        scope: input.scope ?? existing[0].scope,
        metadata: input.metadata ?? (existing[0].metadata as Record<string, unknown>),
        updatedAt: now,
      })
      .where(eq(dbSchema.projectOauthTokens.id, existing[0].id));
  } else {
    await db.insert(dbSchema.projectOauthTokens).values({
      projectKey,
      userId,
      provider: input.provider,
      accessToken: input.accessToken ?? null,
      refreshToken: input.refreshToken ?? null,
      expiresAt,
      tokenType: input.tokenType ?? null,
      scope: input.scope ?? null,
      metadata: (input.metadata ?? {}) as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
    });
  }

  return { ok: true, provider: input.provider };
}

export async function getOAuthToken(
  projectKey: string,
  userId: string,
  provider: string,
): Promise<OAuthTokenRecord | null> {
  if (!provider) throw AppError.badRequest("provider is required");

  const rows = await db.select()
    .from(dbSchema.projectOauthTokens)
    .where(and(
      eq(dbSchema.projectOauthTokens.projectKey, projectKey),
      eq(dbSchema.projectOauthTokens.userId, userId),
      eq(dbSchema.projectOauthTokens.provider, provider),
    )).limit(1);

  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    provider: r.provider,
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    tokenType: r.tokenType,
    scope: r.scope,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listOAuthTokens(
  projectKey: string,
  userId: string,
): Promise<OAuthTokenRecord[]> {
  const rows = await db.select()
    .from(dbSchema.projectOauthTokens)
    .where(and(
      eq(dbSchema.projectOauthTokens.projectKey, projectKey),
      eq(dbSchema.projectOauthTokens.userId, userId),
    ));

  return rows.map((r) => ({
    provider: r.provider,
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    tokenType: r.tokenType,
    scope: r.scope,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function deleteOAuthToken(
  projectKey: string,
  userId: string,
  provider: string,
): Promise<{ ok: true; deleted: boolean }> {
  if (!provider) throw AppError.badRequest("provider is required");

  await db.delete(dbSchema.projectOauthTokens)
    .where(and(
      eq(dbSchema.projectOauthTokens.projectKey, projectKey),
      eq(dbSchema.projectOauthTokens.userId, userId),
      eq(dbSchema.projectOauthTokens.provider, provider),
    ));

  return { ok: true, deleted: true };
}
