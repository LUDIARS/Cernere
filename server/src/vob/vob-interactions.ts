/**
 * V.O.B Discord サーバーのスラッシュコマンド `/register` (日本語名 `/登録`) の処理
 * (spec/feature/vob-discord-registration.md §1)。
 *
 * 署名検証は HTTP 層で済ませた前提。ここでは
 *   PING → PONG、/register → サーバー参加と連携済みを確かめ、一回限りの登録リンクを本人だけに返す。
 * 依存 (DB・Discord API) は差し替えられるようにし、判定の順番をテストで固定する。
 * @implements SPEC-VOB-DISCORD-REGISTRATION
 */
import type { VobConfig } from "./vob-config.js";
import type { GuildMembership } from "./discord-guild.js";
import type { IssueVobTokenInput, IssuedVobToken } from "./vob-token-store.js";

export const VOB_COMMAND_NAMES = ["register", "登録"] as const;

/** Discord interaction type / response type (一部)。 */
const PING = 1;
const APPLICATION_COMMAND = 2;
const PONG = 1;
const CHANNEL_MESSAGE = 4;
const EPHEMERAL = 1 << 6;

export interface VobInteractionDeps {
  config: VobConfig;
  isDiscordLinked(discordUserId: string): Promise<boolean>;
  fetchGuildMember(discordUserId: string): Promise<GuildMembership | null>;
  issueToken(input: IssueVobTokenInput): Promise<IssuedVobToken>;
}

interface Interaction {
  type?: number;
  guild_id?: string;
  data?: { name?: string };
  member?: { user?: { id?: string; username?: string } };
  user?: { id?: string };
}

export type InteractionReply = { type: number; data?: { content: string; flags: number; allowed_mentions: { parse: never[] } } };

function reply(content: string): InteractionReply {
  return { type: CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } };
}

export const VOB_MESSAGES = {
  wrongGuild: "このコマンドは V.O.B のサーバーでだけ使えます。",
  notMember: "V.O.B のサーバーへの参加を確認できませんでした。参加してからもう一度お試しください。",
  alreadyLinked: "この Discord アカウントは、すでに Cernere のアカウントとつながっています。ログイン画面からログインしてください。",
  unavailable: "いま登録リンクを発行できません。しばらくしてからもう一度お試しください。",
  unknownCommand: "このコマンドには対応していません。",
} as const;

export function vobLinkMessage(url: string, expiresAt: Date): string {
  const minutes = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60_000));
  return [
    "Cernere の登録リンクです (あなたにだけ表示されています)。",
    url,
    `${minutes} 分以内に、1 回だけ使えます。リンクは他の人に渡さないでください。`,
  ].join("\n");
}

export async function handleVobInteraction(body: unknown, deps: VobInteractionDeps): Promise<InteractionReply> {
  const interaction = (body ?? {}) as Interaction;
  if (interaction.type === PING) return { type: PONG };
  if (interaction.type !== APPLICATION_COMMAND) return reply(VOB_MESSAGES.unknownCommand);
  if (!VOB_COMMAND_NAMES.includes(interaction.data?.name as typeof VOB_COMMAND_NAMES[number])) return reply(VOB_MESSAGES.unknownCommand);
  // DM からの呼出 (guild_id なし) や別サーバーには発行しない。
  if (interaction.guild_id !== deps.config.guildId) return reply(VOB_MESSAGES.wrongGuild);
  const discordUserId = interaction.member?.user?.id;
  if (!discordUserId) return reply(VOB_MESSAGES.wrongGuild);

  try {
    if (await deps.isDiscordLinked(discordUserId)) return reply(VOB_MESSAGES.alreadyLinked);
    // interaction の member は Discord 署名で守られているが、決定どおり API でも参加記録を引く。
    const member = await deps.fetchGuildMember(discordUserId);
    if (!member) return reply(VOB_MESSAGES.notMember);
    const issued = await deps.issueToken({
      discordUserId,
      discordUsername: member.username ?? interaction.member?.user?.username ?? null,
      guildJoinedAt: member.joinedAt,
      organizationId: deps.config.organizationId,
    });
    const url = `${deps.config.frontendUrl}/start?${new URLSearchParams({ vob: issued.token })}`;
    return reply(vobLinkMessage(url, issued.expiresAt));
  } catch {
    return reply(VOB_MESSAGES.unavailable);
  }
}
