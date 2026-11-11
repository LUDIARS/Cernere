/**
 * Discord サーバーに参加して日が浅い人の許可制 (spec/feature/vob-discord-registration.md §1)。
 * 参加から windowDays 日未満、または参加日時が分からない人は、登録しても管理者の許可まで使えない。
 * @implements SPEC-VOB-DISCORD-REGISTRATION
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function requiresAdminApproval(guildJoinedAt: Date | null, now: Date, windowDays: number): boolean {
  if (windowDays <= 0) return false;
  // 参加日時を確かめられないときは、日が浅い側に倒す (自動許可しない)。
  if (!guildJoinedAt) return true;
  return now.getTime() - guildJoinedAt.getTime() < windowDays * DAY_MS;
}
