/**
 * @cernere/auth — @cernere/id-service への互換レイヤー
 *
 * 全エクスポートを id-service パッケージに委譲する。
 */

export {
  // Types (backward compat aliases)
  type AuthUser,
  type AuthUserRepo,
  type AuthUserListRepo,
  type AuthUserBasic,
  type AuthSession,
  type AuthSessionRepo,
  type AuthGroupMemberRepo,
  type AuthGroupRepo,
  type AuthAppSettingsRepo,
  type AuthSecretManager,
  type AuthConfig,

  // Core types
  type CoreUser,
  type IdUserRepo,
  type IdUserListRepo,
  type IdUserBasic,
  type IdSession,
  type IdSessionRepo,
  type IdGroupMemberRepo,
  type IdGroupRepo,
  type IdAppSettingsRepo,
  type IdSecretManager,
  type IdServiceConfig,
  type GetRedis,
  type LogActivity,
  type UserRole,

  // Session
  type SessionData,
  type SessionStore,

  // Plugin
  type ProfilePlugin,
  type ProfileFieldDef,
  type ProfileRepo,
  PluginRegistry,
  pluginRegistry,

  // Functions
  resolveJwtSecret,
  createSessionStore,
  requireRole,
  createUserContext,
  getUserId,
  getUserRole,
  createAuthRoutes,
} from "../../id-service/src/index.js";
