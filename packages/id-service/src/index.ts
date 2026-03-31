/**
 * @cernere/id-service — 汎用 Identity Service
 *
 * JWT認証、セッション管理、Google OAuth、ミドルウェア、
 * プラグイン方式のプロフィール拡張、マイグレーションスキャナーを提供する。
 */

// ─── Core Types ────────────────────────────────────────────
export type {
  CoreUser,
  IdSession,
  IdUserRepo,
  IdUserBasic,
  IdUserListRepo,
  IdSessionRepo,
  IdGroupMemberRepo,
  IdGroupRepo,
  IdAppSettingsRepo,
  IdSecretManager,
  GetRedis,
  LogActivity,
  UserRole,
} from "./core/types.js";

// ─── Id Service Config ─────────────────────────────────────
export type { IdServiceConfig } from "./id-service.js";

// ─── JWT ───────────────────────────────────────────────────
export { resolveJwtSecret } from "./core/jwt.js";

// ─── Session Store ─────────────────────────────────────────
export { createSessionStore } from "./core/session-store.js";
export type { SessionData, SessionStore } from "./core/session-store.js";

// ─── Middleware ────────────────────────────────────────────
export { requireRole, createUserContext } from "./core/middleware.js";

// ─── Helpers ───────────────────────────────────────────────
export { getUserId, getUserRole } from "./core/helpers.js";

// ─── Routes ────────────────────────────────────────────────
export { createAuthRoutes } from "./core/routes.js";

// ─── Plugin System ─────────────────────────────────────────
export type {
  ProfilePlugin,
  ProfileFieldDef,
  ProfileFieldType,
  UserServiceProfile,
  ProfileRepo,
} from "./plugin/types.js";
export { PluginRegistry, pluginRegistry } from "./plugin/registry.js";

// ─── Migration ─────────────────────────────────────────────
export { RepoScanner, scanAndGenerateConfig } from "./migration/scanner.js";
export type { DetectedSchema, DetectedField, MigrationConfig } from "./migration/scanner.js";

// ─── Backward Compatibility (packages/auth 互換) ──────────
// 旧 @cernere/auth パッケージの型名を re-export
export type { CoreUser as AuthUser } from "./core/types.js";
export type { IdUserRepo as AuthUserRepo } from "./core/types.js";
export type { IdUserListRepo as AuthUserListRepo } from "./core/types.js";
export type { IdUserBasic as AuthUserBasic } from "./core/types.js";
export type { IdSession as AuthSession } from "./core/types.js";
export type { IdSessionRepo as AuthSessionRepo } from "./core/types.js";
export type { IdGroupMemberRepo as AuthGroupMemberRepo } from "./core/types.js";
export type { IdGroupRepo as AuthGroupRepo } from "./core/types.js";
export type { IdAppSettingsRepo as AuthAppSettingsRepo } from "./core/types.js";
export type { IdSecretManager as AuthSecretManager } from "./core/types.js";
export type { IdServiceConfig as AuthConfig } from "./id-service.js";
