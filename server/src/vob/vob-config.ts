/**
 * V.O.B の Discord 登録の設定 (spec/feature/vob-discord-registration.md §4)。
 * 正本は DB の discord_bot_settings 1 行 (管理画面で書く)。環境変数からは読まない。
 * ここは「保存値 → 使える設定」の純粋な検証だけを持つ。DB の読み書きは discord-bot-settings-store.ts。
 * 無効 (enabled=false)・欠け・形式違いは null = 機能は無効。
 * @implements SPEC-VOB-DISCORD-REGISTRATION
 */

export interface VobConfig {
  applicationId: string;
  publicKeyHex: string;
  botToken: string;
  guildId: string;
  organizationId: string;
  /** コマンド発行を知らせる管理者だけが見えるチャンネル。null なら通知しない */
  adminChannelId: string | null;
  /** サーバー参加からこの日数未満の人は管理者の許可が要る。0 なら誰も要らない */
  approvalWindowDays: number;
  frontendUrl: string;
}

/** 保存値 (復号済み) の形。DB の行そのものではなく、検証前の素材。 */
export interface VobConfigInput {
  enabled: boolean;
  applicationId: string | null;
  publicKeyHex: string | null;
  botToken: string | null;
  guildId: string | null;
  organizationId: string | null;
  adminChannelId: string | null;
  approvalWindowDays: number | null;
}

export const SNOWFLAKE = /^\d{5,25}$/;
export const PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/i;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_APPROVAL_WINDOW_DAYS = 90;

export function isValidApprovalWindowDays(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_APPROVAL_WINDOW_DAYS;
}

const trimmed = (value: string | null): string => (value ?? "").trim();

/** 設定が揃っていれば返す。無効・欠け・形式違いは null。管理者チャンネルだけは空でよい (形式違いは null)。 */
export function parseVobConfig(input: VobConfigInput, frontendUrl: string): VobConfig | null {
  if (!input.enabled) return null;
  const applicationId = trimmed(input.applicationId);
  const publicKeyHex = trimmed(input.publicKeyHex);
  const botToken = trimmed(input.botToken);
  const guildId = trimmed(input.guildId);
  const organizationId = trimmed(input.organizationId);
  const adminChannel = trimmed(input.adminChannelId);
  if (!SNOWFLAKE.test(applicationId) || !PUBLIC_KEY_HEX.test(publicKeyHex) || !botToken) return null;
  if (!SNOWFLAKE.test(guildId) || !UUID.test(organizationId)) return null;
  if (adminChannel && !SNOWFLAKE.test(adminChannel)) return null;
  if (!isValidApprovalWindowDays(input.approvalWindowDays)) return null;
  return {
    applicationId,
    publicKeyHex,
    botToken,
    guildId,
    organizationId,
    adminChannelId: adminChannel || null,
    approvalWindowDays: input.approvalWindowDays,
    frontendUrl: frontendUrl.trim().replace(/\/+$/, ""),
  };
}

/** 登録リンクの戻り先 (フロントの公開 URL)。これは Bot の設定ではなくサービス全体の配置値。 */
export function frontendUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env.FRONTEND_URL ?? "http://localhost:5173").trim().replace(/\/+$/, "");
}
