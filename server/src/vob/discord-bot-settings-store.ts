/**
 * discord_bot_settings (migration 083、id=1 の 1 行) の読み書き。
 * - Bot トークンは secret-box で暗号化して保存し、外へは hasBotToken だけを出す。
 * - 保存時にトークンを省略したら既存の暗号文をそのまま残す。
 * - 復号できない (鍵が変わった・壊れた) ときは機能を無効として扱う (平文に倒さない)。
 * @implements SPEC-VOB-DISCORD-REGISTRATION
 */
import { eq } from "drizzle-orm";
import { config as serverConfig } from "../config.js";
import { db } from "../db/connection.js";
import { discordBotSettings } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "../lib/crypto/secret-box.js";
import { devError } from "../logging/dev-logger.js";
import { frontendUrlFromEnv, parseVobConfig, type VobConfig, type VobConfigInput } from "./vob-config.js";

const SETTINGS_ID = 1;
export const VOB_INTERACTIONS_PATH = "/api/discord/vob/interactions";
const DEFAULT_APPROVAL_WINDOW_DAYS = 7;

type Row = typeof discordBotSettings.$inferSelect;

/** 復号済みの保存値。botTokenUnreadable は暗号文があるのに復号できなかった印。 */
export interface StoredDiscordBotSettings extends VobConfigInput {
  approvalWindowDays: number;
  hasBotToken: boolean;
  botTokenUnreadable: boolean;
  updatedAt: Date | null;
}

export interface DiscordBotSettingsView {
  enabled: boolean;
  applicationId: string | null;
  publicKeyHex: string | null;
  hasBotToken: boolean;
  botTokenUnreadable: boolean;
  guildId: string | null;
  organizationId: string | null;
  adminChannelId: string | null;
  approvalWindowDays: number;
  /** 保存値が揃っていて、Discord からの interaction を受けられる状態 */
  ready: boolean;
  /** Discord Developer Portal の Interactions Endpoint URL に入れる値 (Cernere サーバーの公開 URL) */
  interactionsEndpointUrl: string;
  updatedAt: string | null;
}

/** 書込み内容 (検証済み)。botToken が undefined なら既存のトークンを残す。 */
export interface DiscordBotSettingsUpdate {
  enabled: boolean;
  applicationId: string | null;
  publicKeyHex: string | null;
  botToken?: string;
  guildId: string | null;
  organizationId: string | null;
  adminChannelId: string | null;
  approvalWindowDays: number;
}

function readToken(enc: string | null): { botToken: string | null; unreadable: boolean } {
  if (!enc) return { botToken: null, unreadable: false };
  try {
    return { botToken: decryptSecret(enc), unreadable: false };
  } catch (err) {
    // 鍵の不一致・改ざん。機能を止めて原因はサーバー側にだけ残す (トークンは記録しない)。
    devError("vob.discord_bot.token_unreadable", err, {});
    return { botToken: null, unreadable: true };
  }
}

export function toStoredSettings(row: Row | undefined): StoredDiscordBotSettings {
  const token = readToken(row?.botTokenEnc ?? null);
  return {
    enabled: row?.enabled ?? false,
    applicationId: row?.applicationId ?? null,
    publicKeyHex: row?.publicKeyHex ?? null,
    botToken: token.botToken,
    guildId: row?.guildId ?? null,
    organizationId: row?.organizationId ?? null,
    adminChannelId: row?.adminChannelId ?? null,
    approvalWindowDays: row?.approvalWindowDays ?? DEFAULT_APPROVAL_WINDOW_DAYS,
    hasBotToken: !!row?.botTokenEnc,
    botTokenUnreadable: token.unreadable,
    updatedAt: row?.updatedAt ?? null,
  };
}

export function toSettingsView(stored: StoredDiscordBotSettings, publicUrl: string, frontendUrl: string): DiscordBotSettingsView {
  return {
    enabled: stored.enabled,
    applicationId: stored.applicationId,
    publicKeyHex: stored.publicKeyHex,
    hasBotToken: stored.hasBotToken,
    botTokenUnreadable: stored.botTokenUnreadable,
    guildId: stored.guildId,
    organizationId: stored.organizationId,
    adminChannelId: stored.adminChannelId,
    approvalWindowDays: stored.approvalWindowDays,
    ready: parseVobConfig(stored, frontendUrl) !== null,
    interactionsEndpointUrl: `${publicUrl.replace(/\/+$/, "")}${VOB_INTERACTIONS_PATH}`,
    updatedAt: stored.updatedAt?.toISOString() ?? null,
  };
}

/**
 * upsert する列。トークン省略時は bot_token_enc を set に含めない (既存を残す)。
 * 新規行でトークン省略なら null。
 */
export function settingsWriteValues(update: DiscordBotSettingsUpdate, actorUserId: string, now: Date,
  encrypt: (plain: string) => string = encryptSecret) {
  const base = {
    enabled: update.enabled,
    applicationId: update.applicationId,
    publicKeyHex: update.publicKeyHex,
    guildId: update.guildId,
    organizationId: update.organizationId,
    adminChannelId: update.adminChannelId,
    approvalWindowDays: update.approvalWindowDays,
    updatedByUserId: actorUserId,
    updatedAt: now,
  };
  const set = update.botToken === undefined ? base : { ...base, botTokenEnc: encrypt(update.botToken) };
  return { insert: { id: SETTINGS_ID, botTokenEnc: null, ...set }, set };
}

export async function loadStoredSettings(): Promise<StoredDiscordBotSettings> {
  const row = (await db.select().from(discordBotSettings).where(eq(discordBotSettings.id, SETTINGS_ID)).limit(1))[0];
  return toStoredSettings(row);
}

/** 審査画面の表示用: 許可が要る日数だけを読む (Bot トークンには触れない)。行が無ければ既定値。 */
export async function readApprovalWindowDays(): Promise<number> {
  const row = (await db.select({ days: discordBotSettings.approvalWindowDays }).from(discordBotSettings)
    .where(eq(discordBotSettings.id, SETTINGS_ID)).limit(1))[0];
  return row?.days ?? DEFAULT_APPROVAL_WINDOW_DAYS;
}

/** 使える設定。無効・欠け・復号失敗は null。 */
export async function loadVobConfig(): Promise<VobConfig | null> {
  return parseVobConfig(await loadStoredSettings(), frontendUrlFromEnv());
}

export async function getDiscordBotSettings(): Promise<DiscordBotSettingsView> {
  return toSettingsView(await loadStoredSettings(), serverConfig.publicUrl, frontendUrlFromEnv());
}

export async function saveDiscordBotSettings(actorUserId: string, update: DiscordBotSettingsUpdate,
  now = new Date()): Promise<DiscordBotSettingsView> {
  const values = settingsWriteValues(update, actorUserId, now);
  await db.insert(discordBotSettings).values(values.insert)
    .onConflictDoUpdate({ target: discordBotSettings.id, set: values.set });
  return getDiscordBotSettings();
}
