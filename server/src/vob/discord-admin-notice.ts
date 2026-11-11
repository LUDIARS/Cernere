/**
 * 管理者だけが見える Discord チャンネルへの通知 (spec/feature/vob-discord-registration.md §1)。
 *   - 文面の組立ては純粋関数 (formatAdminNotice)。
 *   - 送信は postAdminNotice。mention は allowed_mentions で全部止め、文中の他人の文字列も無害化する。
 * @implements SPEC-VOB-DISCORD-REGISTRATION
 */

const API = "https://discord.com/api/v10";
const DISCORD_MESSAGE_MAX = 2000;
const NAME_MAX = 64;
/** 制御文字・ゼロ幅文字・行/段落区切り (表示を崩したり mention を隠したりできる文字)。 */
const INVISIBLE_OR_CONTROL = /[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u2060]/g;
const WORD_JOINER = "\u2060";

export type AdminNoticeResult = "issued" | "issued_needs_approval" | "not_member" | "already_linked" | "pending_signup";

export interface AdminNotice {
  result: AdminNoticeResult;
  discordUserId: string;
  discordUsername: string | null;
  guildJoinedAt: Date | null;
  tokenExpiresAt: Date | null;
}

const RESULT_TEXT: Record<AdminNoticeResult, string> = {
  issued: "登録リンクを発行しました",
  issued_needs_approval: "登録リンクを発行しました (サーバー参加から日が浅いため、登録後に管理者の許可が要ります)",
  not_member: "サーバーへの参加を確認できなかったため、発行しませんでした",
  already_linked: "すでに Cernere のアカウントとつながっているため、発行しませんでした",
  pending_signup: "登録が完了し、管理者の許可待ちになりました (Cernere の審査画面で許可してください)",
};

/**
 * 他人が決めた文字列 (Discord のユーザ名) を通知に載せる形にする。
 * 改行・制御文字を落とし、@ と markdown 記号を無効化し、長さを切る。
 * allowed_mentions でも止めるが、文面だけ見ても mention に見えないようにする (二重の防御)。
 */
export function sanitizeForNotice(value: string): string {
  const flat = value.replace(INVISIBLE_OR_CONTROL, " ").trim();
  const cut = flat.length > NAME_MAX ? `${flat.slice(0, NAME_MAX)}…` : flat;
  // @ の直後に word joiner を入れて @everyone / @here に見えなくし、<@id> や markdown の記号はエスケープする。
  return cut.replace(/@/g, `@${WORD_JOINER}`).replace(/([\\`*_~|>#<\[\]])/g, "\\$1");
}

export function formatAdminNotice(notice: AdminNotice): string {
  const name = notice.discordUsername ? sanitizeForNotice(notice.discordUsername) : "(不明)";
  const lines = [
    `【Cernere 登録】${RESULT_TEXT[notice.result]}`,
    `Discord: ${name} (ID ${notice.discordUserId})`,
    `サーバー参加: ${notice.guildJoinedAt ? notice.guildJoinedAt.toISOString() : "不明"}`,
  ];
  if (notice.tokenExpiresAt) lines.push(`リンクの期限: ${notice.tokenExpiresAt.toISOString()}`);
  const text = lines.join("\n");
  return text.length > DISCORD_MESSAGE_MAX ? text.slice(0, DISCORD_MESSAGE_MAX) : text;
}

export class AdminNoticeError extends Error {
  constructor(message: string) { super(message); this.name = "AdminNoticeError"; }
}

export async function postAdminNotice(botToken: string, channelId: string, content: string,
  fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!/^\d{5,25}$/.test(channelId)) throw new AdminNoticeError("invalid admin channel id");
  const res = await fetchImpl(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new AdminNoticeError(`Discord admin notice failed (${res.status})`);
}

export interface AdminNoticeTarget { botToken: string; adminChannelId: string | null }

/**
 * 待たずに送る (Discord の 3 秒期限・signup の応答を通知で遅らせない)。
 * 管理者チャンネルが未設定なら送らない。失敗は onError に渡すだけで呼出元へは伝えない。
 */
export function sendAdminNoticeInBackground(target: AdminNoticeTarget, notice: AdminNotice,
  onError: (err: unknown) => void, fetchImpl: typeof fetch = fetch): void {
  if (!target.adminChannelId) return;
  postAdminNotice(target.botToken, target.adminChannelId, formatAdminNotice(notice), fetchImpl).catch(onError);
}
