/**
 * Cernere の Discord Bot のスラッシュコマンド定義と、guild への登録
 * (spec/feature/vob-discord-registration.md §7)。管理画面のボタンから呼ぶ。
 * guild コマンドとして上書き登録する (PUT は冪等)。トークンは返さない・記録しない。
 * @implements SPEC-VOB-DISCORD-REGISTRATION
 */

const API = "https://discord.com/api/v10";

export const VOB_SLASH_COMMANDS = [{
  name: "register",
  name_localizations: { ja: "登録" },
  description: "Get a one-time Cernere registration link",
  description_localizations: { ja: "Cernere の登録リンクを受け取る (本人だけに表示、30 分・1 回限り)" },
  type: 1,
  dm_permission: false,
}] as const;

export class CommandRegistrationError extends Error {
  constructor(message: string) { super(message); this.name = "CommandRegistrationError"; }
}

export interface CommandRegistrationTarget {
  applicationId: string;
  botToken: string;
  guildId: string;
}

/** 登録できたコマンド名 (例 ["register"]) を返す。 */
export async function registerGuildCommands(target: CommandRegistrationTarget,
  fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(`${API}/applications/${target.applicationId}/guilds/${target.guildId}/commands`, {
    method: "PUT",
    redirect: "error",
    headers: { Authorization: `Bot ${target.botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(VOB_SLASH_COMMANDS),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new CommandRegistrationError(`Discord command registration failed (${res.status})`);
  const saved = await res.json() as Array<{ name?: unknown }>;
  return Array.isArray(saved) ? saved.map((c) => String(c.name ?? "")).filter(Boolean) : [];
}
