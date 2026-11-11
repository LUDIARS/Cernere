/**
 * Cernere の Discord Bot の設定 (admin) の WS API (spec/feature/vob-discord-registration.md §4)。
 * 保存はこの端末のパスキーで確かめる (discord_bot.update、ws-client が自動で proof を取る)。
 */

import { wsClient } from "./ws-client";

export interface DiscordBotSettingsView {
  enabled: boolean;
  applicationId: string | null;
  publicKeyHex: string | null;
  /** Bot トークンは表示しない。保存済みかどうかだけ */
  hasBotToken: boolean;
  /** 保存済みのトークンを復号できない (鍵が変わった等)。入れ直しが要る */
  botTokenUnreadable: boolean;
  guildId: string | null;
  organizationId: string | null;
  adminChannelId: string | null;
  approvalWindowDays: number;
  ready: boolean;
  interactionsEndpointUrl: string;
  updatedAt: string | null;
}

export interface DiscordBotSettingsUpdate {
  enabled: boolean;
  applicationId: string | null;
  publicKeyHex: string | null;
  /** 省略すると保存済みのトークンを残す */
  botToken?: string;
  guildId: string | null;
  organizationId: string | null;
  adminChannelId: string | null;
  approvalWindowDays: number;
}

export const discordBotApi = {
  get(): Promise<DiscordBotSettingsView> {
    return wsClient.sendCommand<DiscordBotSettingsView>("discord_bot", "get", {});
  },
  update(update: DiscordBotSettingsUpdate): Promise<DiscordBotSettingsView> {
    return wsClient.sendCommand<DiscordBotSettingsView>("discord_bot", "update", { ...update });
  },
  registerCommands(): Promise<{ registered: string[] }> {
    return wsClient.sendCommand<{ registered: string[] }>("discord_bot", "register_commands", {});
  },
};
