#!/usr/bin/env node
/**
 * V.O.B の Discord サーバーにスラッシュコマンド /register (日本語名 /登録) を登録する
 * (spec/feature/vob-discord-registration.md §7)。
 *
 * 必要な環境変数 (Excubitor Vault: cernere):
 *   CERNERE_VOB_DISCORD_APPLICATION_ID  Discord アプリ ID
 *   CERNERE_VOB_DISCORD_BOT_TOKEN       Bot トークン
 *   CERNERE_VOB_DISCORD_GUILD_ID        V.O.B サーバー ID
 *
 * guild コマンドとして上書き登録する (PUT は冪等)。トークンは表示しない。
 */

const appId = process.env.CERNERE_VOB_DISCORD_APPLICATION_ID ?? "";
const botToken = process.env.CERNERE_VOB_DISCORD_BOT_TOKEN ?? "";
const guildId = process.env.CERNERE_VOB_DISCORD_GUILD_ID ?? "";

if (!/^\d{5,25}$/.test(appId) || !/^\d{5,25}$/.test(guildId) || !botToken) {
  console.error("CERNERE_VOB_DISCORD_APPLICATION_ID / CERNERE_VOB_DISCORD_BOT_TOKEN / CERNERE_VOB_DISCORD_GUILD_ID を設定してください。");
  process.exit(2);
}

const commands = [{
  name: "register",
  name_localizations: { ja: "登録" },
  description: "Get a one-time Cernere registration link",
  description_localizations: { ja: "Cernere の登録リンクを受け取る (本人だけに表示、30 分・1 回限り)" },
  type: 1,
  dm_permission: false,
}];

const res = await fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
  body: JSON.stringify(commands),
});
if (!res.ok) {
  console.error(`登録に失敗しました: HTTP ${res.status}`);
  process.exit(1);
}
const saved = await res.json();
console.log(`登録しました: ${saved.map((c) => `/${c.name}`).join(", ")}`);
