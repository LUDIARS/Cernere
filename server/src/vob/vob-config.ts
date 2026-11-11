/**
 * V.O.B の Discord 登録の設定 (spec/feature/vob-discord-registration.md §4)。
 * 値は Excubitor Vault (cernere) から環境変数で渡る。どれかが欠けたら機能は無効。
 * @implements SPEC-VOB-DISCORD-REGISTRATION
 */

export interface VobConfig {
  publicKeyHex: string;
  botToken: string;
  guildId: string;
  organizationId: string;
  frontendUrl: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 設定が揃っていれば返す。欠け・形式違い (公開鍵が 32 byte hex でない、組織が UUID でない) は null。 */
export function readVobConfig(env: NodeJS.ProcessEnv = process.env): VobConfig | null {
  const publicKeyHex = (env.CERNERE_VOB_DISCORD_PUBLIC_KEY ?? "").trim();
  const botToken = (env.CERNERE_VOB_DISCORD_BOT_TOKEN ?? "").trim();
  const guildId = (env.CERNERE_VOB_DISCORD_GUILD_ID ?? "").trim();
  const organizationId = (env.CERNERE_VOB_ORGANIZATION_ID ?? "").trim();
  const frontendUrl = (env.FRONTEND_URL ?? "http://localhost:5173").trim().replace(/\/+$/, "");
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) return null;
  if (!botToken || !/^\d{5,25}$/.test(guildId) || !UUID.test(organizationId)) return null;
  return { publicKeyHex, botToken, guildId, organizationId, frontendUrl };
}
