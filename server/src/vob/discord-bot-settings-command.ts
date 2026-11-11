/**
 * 管理画面の WS module `discord_bot` (system admin 専用)。
 *   get                 設定の表示用 view (Bot トークンは hasBotToken だけ)
 *   update              設定の保存 (action proof discord_bot.update は WS 層で確認済み)
 *   register_commands   保存済みの設定でスラッシュコマンド /register (/登録) を guild に登録
 * @implements SPEC-VOB-DISCORD-REGISTRATION
 */
import { z } from "zod";
import { AppError } from "../error.js";
import { devError } from "../logging/dev-logger.js";
import { CommandRegistrationError, registerGuildCommands, type CommandRegistrationTarget } from "./discord-commands.js";
import {
  getDiscordBotSettings, loadStoredSettings, saveDiscordBotSettings,
  type DiscordBotSettingsUpdate, type DiscordBotSettingsView, type StoredDiscordBotSettings,
} from "./discord-bot-settings-store.js";
import { MAX_APPROVAL_WINDOW_DAYS, parseVobConfig, PUBLIC_KEY_HEX, SNOWFLAKE, UUID } from "./vob-config.js";

/** 空文字は「未設定」= null。値があれば形式を確かめる。 */
const optionalMatching = (pattern: RegExp, label: string) => z.string().trim().max(128)
  .transform((value) => value || null)
  .refine((value) => value === null || pattern.test(value), `${label} の形式が正しくありません`)
  .nullable()
  .transform((value) => value ?? null);

export const discordBotUpdateSchema = z.object({
  enabled: z.boolean(),
  applicationId: optionalMatching(SNOWFLAKE, "Application ID"),
  publicKeyHex: optionalMatching(PUBLIC_KEY_HEX, "Public Key"),
  /** 省略 (または空) なら既存のトークンを残す */
  botToken: z.string().trim().max(256).optional().transform((value) => value || undefined),
  guildId: optionalMatching(SNOWFLAKE, "サーバー ID"),
  organizationId: optionalMatching(UUID, "組織 ID"),
  adminChannelId: optionalMatching(SNOWFLAKE, "管理者チャンネル ID"),
  approvalWindowDays: z.number().int().min(0).max(MAX_APPROVAL_WINDOW_DAYS),
}).strict();

export interface DiscordBotCommandDeps {
  requireAdmin(userId: string): Promise<void>;
  load(): Promise<StoredDiscordBotSettings>;
  view(): Promise<DiscordBotSettingsView>;
  save(actorUserId: string, update: DiscordBotSettingsUpdate): Promise<DiscordBotSettingsView>;
  registerCommands(target: CommandRegistrationTarget): Promise<string[]>;
}

export function defaultDiscordBotCommandDeps(requireAdmin: (userId: string) => Promise<void>): DiscordBotCommandDeps {
  return {
    requireAdmin,
    load: loadStoredSettings,
    view: getDiscordBotSettings,
    save: saveDiscordBotSettings,
    registerCommands: (target) => registerGuildCommands(target),
  };
}

async function update(actorUserId: string, payload: unknown, deps: DiscordBotCommandDeps): Promise<DiscordBotSettingsView> {
  const parsed = discordBotUpdateSchema.safeParse(payload ?? {});
  if (!parsed.success) throw AppError.badRequest(parsed.error.issues[0]?.message ?? "Invalid Discord Bot settings");
  const next: DiscordBotSettingsUpdate = parsed.data;
  if (next.enabled) {
    // 有効にするなら、トークン (新しく入れた値か既存) を含めて揃っていること。
    const stored = await deps.load();
    const botToken = next.botToken ?? stored.botToken;
    if (!parseVobConfig({ ...next, botToken }, "http://unused")) {
      throw AppError.badRequest("有効にするには Application ID・Public Key・Bot トークン・サーバー ID・組織 ID が必要です");
    }
  }
  return deps.save(actorUserId, next);
}

async function registerCommands(deps: DiscordBotCommandDeps): Promise<{ registered: string[] }> {
  const stored = await deps.load();
  const applicationId = stored.applicationId ?? "";
  const guildId = stored.guildId ?? "";
  if (!SNOWFLAKE.test(applicationId) || !SNOWFLAKE.test(guildId) || !stored.botToken) {
    throw AppError.badRequest("先に Application ID・Bot トークン・サーバー ID を保存してください");
  }
  try {
    return { registered: await deps.registerCommands({ applicationId, guildId, botToken: stored.botToken }) };
  } catch (err) {
    if (err instanceof CommandRegistrationError) throw AppError.withCode(502, "discord_command_registration_failed", err.message);
    throw err;
  }
}

export async function discordBotSettingsCommand(actorUserId: string, action: string, payload: unknown,
  deps: DiscordBotCommandDeps): Promise<unknown> {
  await deps.requireAdmin(actorUserId);
  try {
    switch (action) {
      case "get": return await deps.view();
      case "update": return await update(actorUserId, payload, deps);
      case "register_commands": return await registerCommands(deps);
      default: throw AppError.badRequest("Unknown discord_bot action");
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    devError("vob.discord_bot.admin.failed", error, { action });
    throw AppError.serviceUnavailable("Discord Bot の設定を読み書きできませんでした。");
  }
}
