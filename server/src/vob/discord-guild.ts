/**
 * Discord サーバー (guild) の参加確認。Bot で `GET /guilds/{guild}/members/{user}` を引く。
 * 404 (参加していない / 不明な user) は null。Bot に Server Members Intent が要る。
 * それ以外の失敗は確認できないので例外にする (参加済みとみなさない)。
 * @implements SPEC-VOB-DISCORD-REGISTRATION
 */

const API = "https://discord.com/api/v10";

export interface GuildMembership {
  discordUserId: string;
  username: string | null;
  joinedAt: Date | null;
}

export class GuildLookupError extends Error {
  constructor(message: string) { super(message); this.name = "GuildLookupError"; }
}

export async function fetchGuildMember(botToken: string, guildId: string, discordUserId: string,
  fetchImpl: typeof fetch = fetch): Promise<GuildMembership | null> {
  if (!/^\d{5,25}$/.test(discordUserId)) return null;
  const res = await fetchImpl(`${API}/guilds/${guildId}/members/${discordUserId}`, {
    method: "GET",
    redirect: "error",
    headers: { Authorization: `Bot ${botToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new GuildLookupError(`Discord guild member lookup failed (${res.status})`);
  const body = await res.json() as { user?: { id?: string; username?: string; global_name?: string | null }; joined_at?: string };
  if (body.user?.id !== discordUserId) throw new GuildLookupError("Discord returned a different member");
  const joinedAt = typeof body.joined_at === "string" && !Number.isNaN(Date.parse(body.joined_at)) ? new Date(body.joined_at) : null;
  return { discordUserId, username: body.user.username ?? null, joinedAt };
}
