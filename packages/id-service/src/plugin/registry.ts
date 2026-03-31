/**
 * Id Service — プラグインレジストリ
 *
 * サービスは registerPlugin() でプロフィール拡張を登録する。
 * IdService はルートハンドラ内でレジストリを参照し、
 * ユーザー情報にサービス固有フィールドを付与する。
 */

import type { ProfilePlugin, ProfileRepo, ProfileFieldDef } from "./types.js";
import type { CoreUser } from "../core/types.js";

export class PluginRegistry {
  private plugins = new Map<string, ProfilePlugin>();
  private profileRepo: ProfileRepo | null = null;

  /**
   * ProfileRepo をセット (DB 初期化後に呼ぶ)
   */
  setProfileRepo(repo: ProfileRepo): void {
    this.profileRepo = repo;
  }

  /**
   * プラグインを登録
   */
  register(plugin: ProfilePlugin): void {
    if (this.plugins.has(plugin.serviceId)) {
      console.warn(`[id-service] プラグイン "${plugin.serviceId}" は既に登録済み。上書きします。`);
    }
    this.plugins.set(plugin.serviceId, plugin);
    console.log(`[id-service] プラグイン登録: ${plugin.serviceId} (${plugin.serviceName})`);
  }

  /**
   * 登録済みプラグイン取得
   */
  get(serviceId: string): ProfilePlugin | undefined {
    return this.plugins.get(serviceId);
  }

  /**
   * 全プラグイン一覧
   */
  list(): ProfilePlugin[] {
    return [...this.plugins.values()];
  }

  /**
   * ユーザーのサービス固有プロフィールを取得
   */
  async getProfile(userId: string, serviceId: string): Promise<Record<string, unknown>> {
    if (!this.profileRepo) return {};
    const profile = await this.profileRepo.findByUserAndService(userId, serviceId);
    return profile?.profileData ?? {};
  }

  /**
   * ユーザーの全プロフィールを取得 (全サービス分)
   */
  async getAllProfiles(userId: string): Promise<Record<string, Record<string, unknown>>> {
    if (!this.profileRepo) return {};
    const profiles = await this.profileRepo.findByUser(userId);
    const result: Record<string, Record<string, unknown>> = {};
    for (const p of profiles) {
      result[p.serviceId] = p.profileData;
    }
    return result;
  }

  /**
   * ユーザーのプロフィールを保存/更新
   */
  async saveProfile(
    userId: string,
    serviceId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const plugin = this.plugins.get(serviceId);
    if (!plugin) {
      throw new Error(`[id-service] 未登録のサービス: ${serviceId}`);
    }

    // バリデーション
    this.validateProfileData(plugin.profileFields, data);

    if (!this.profileRepo) {
      throw new Error("[id-service] ProfileRepo が未設定です");
    }
    await this.profileRepo.upsert(userId, serviceId, data);
  }

  /**
   * /me レスポンス用にプロフィールデータを整形
   */
  async enrichUserForMe(
    user: CoreUser,
    serviceId?: string,
  ): Promise<Record<string, unknown>> {
    const extra: Record<string, unknown> = {};

    const targetPlugins = serviceId
      ? [this.plugins.get(serviceId)].filter(Boolean) as ProfilePlugin[]
      : [...this.plugins.values()];

    for (const plugin of targetPlugins) {
      const profileData = await this.getProfile(user.id, plugin.serviceId);

      if (plugin.formatForMe) {
        Object.assign(extra, plugin.formatForMe(profileData));
      } else if (plugin.meFields) {
        for (const field of plugin.meFields) {
          if (field in profileData) {
            extra[field] = profileData[field];
          }
        }
      } else {
        // デフォルト: 全フィールドをマージ
        Object.assign(extra, profileData);
      }
    }

    return extra;
  }

  /**
   * ユーザーリスト用にプロフィールフィールドを付与
   */
  async enrichUsersForList(
    users: Array<Record<string, unknown>>,
    serviceId?: string,
  ): Promise<Array<Record<string, unknown>>> {
    if (!this.profileRepo) return users;

    const targetPlugins = serviceId
      ? [this.plugins.get(serviceId)].filter(Boolean) as ProfilePlugin[]
      : [...this.plugins.values()];

    if (targetPlugins.length === 0) return users;

    const enriched = [];
    for (const user of users) {
      const userId = user.id as string;
      const enrichedUser = { ...user };

      for (const plugin of targetPlugins) {
        const profileData = await this.getProfile(userId, plugin.serviceId);
        const fields = plugin.listFields ?? Object.keys(plugin.profileFields);
        for (const field of fields) {
          if (field in profileData) {
            enrichedUser[field] = profileData[field];
          }
        }
      }

      enriched.push(enrichedUser);
    }
    return enriched;
  }

  /**
   * Lifecycle: ユーザー作成時
   */
  async onUserCreated(user: CoreUser, profileDataByService: Record<string, Record<string, unknown>>): Promise<void> {
    for (const [serviceId, profileData] of Object.entries(profileDataByService)) {
      const plugin = this.plugins.get(serviceId);
      if (!plugin) continue;

      if (this.profileRepo && Object.keys(profileData).length > 0) {
        await this.profileRepo.upsert(user.id, serviceId, profileData);
      }

      if (plugin.onUserCreated) {
        await plugin.onUserCreated(user, profileData);
      }
    }
  }

  /**
   * Lifecycle: ユーザー更新時
   */
  async onUserUpdated(user: CoreUser, serviceId: string, profileData: Record<string, unknown>): Promise<void> {
    const plugin = this.plugins.get(serviceId);
    if (!plugin) return;

    if (this.profileRepo && Object.keys(profileData).length > 0) {
      await this.profileRepo.upsert(user.id, serviceId, profileData);
    }

    if (plugin.onUserUpdated) {
      await plugin.onUserUpdated(user, profileData);
    }
  }

  // ─── Private ──────────────────────────────────────────

  private validateProfileData(
    fields: Record<string, ProfileFieldDef>,
    data: Record<string, unknown>,
  ): void {
    for (const [key, def] of Object.entries(fields)) {
      if (def.required && !(key in data)) {
        throw new Error(`[id-service] 必須フィールド "${key}" が不足しています`);
      }

      if (key in data && data[key] !== null && data[key] !== undefined) {
        const val = data[key];
        switch (def.type) {
          case "string":
            if (typeof val !== "string") throw new Error(`[id-service] フィールド "${key}" は string 型です`);
            break;
          case "number":
            if (typeof val !== "number") throw new Error(`[id-service] フィールド "${key}" は number 型です`);
            break;
          case "boolean":
            if (typeof val !== "boolean") throw new Error(`[id-service] フィールド "${key}" は boolean 型です`);
            break;
          case "json":
            // any serializable value
            break;
        }
      }
    }
  }
}

/** シングルトンレジストリ */
export const pluginRegistry = new PluginRegistry();
