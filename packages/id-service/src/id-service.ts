/**
 * Id Service — メイン設定型
 *
 * 各サービスはこの設定を使って IdService を初期化する。
 */

import type {
  IdUserRepo,
  IdUserListRepo,
  IdSessionRepo,
  IdAppSettingsRepo,
  IdGroupMemberRepo,
  IdGroupRepo,
  IdSecretManager,
  GetRedis,
  LogActivity,
} from "./core/types.js";
import type { PluginRegistry } from "./plugin/registry.js";

export interface IdServiceConfig {
  /** JWT シークレット */
  jwtSecret: string;
  /** Secret Manager */
  secretManager: IdSecretManager;
  /** Redis getter */
  getRedis: GetRedis;

  // ─── Repositories ────────────────────────────────────
  userRepo: IdUserRepo;
  userListRepo: IdUserListRepo;
  sessionRepo: IdSessionRepo;
  appSettingsRepo: IdAppSettingsRepo;
  groupMemberRepo: IdGroupMemberRepo;
  groupRepo: IdGroupRepo;

  // ─── Optional ────────────────────────────────────────
  logActivity?: LogActivity;

  /** プラグインレジストリ (プロフィール拡張用) */
  pluginRegistry?: PluginRegistry;
}
