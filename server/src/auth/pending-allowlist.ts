/**
 * 許可待ち (pending) のユーザーが使える WS コマンド (許可制 案 A の「最低限の権限」)。
 *
 * module 名でまとめて許可せず、action と対象 (本人) で決める。ここに無い操作は
 * approval_required で拒否する。新しい action を足したら、ここに入れるかを判断すること
 * (入れなければ既定で拒否される)。
 */

const SELF_ONLY_ACTIONS = new Set<string>([
  "profile.get",
  "profile.update",
  "profile.update_privacy",
  "profile.set_display_name",
  "device_session.list",
  "device_session.revoke",
  "device_session.revoke_all",
  "login_alert.list",
  "login_alert.start",
  "login_alert.verify",
  "login_alert.remove",
  "security_event.list",
  "user_access.status",
  "user_access.apply",
  "user_access.withdraw",
]);

function payloadUserId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = (payload as Record<string, unknown>).userId;
  return typeof value === "string" ? value : undefined;
}

/** pending のユーザーにこの WS コマンドを許すか。 */
export function isAllowedWhilePending(userId: string, module: string, action: string, payload: unknown): boolean {
  const name = `${module}.${action}`;
  if (SELF_ONLY_ACTIONS.has(name)) return true;
  // 自分自身の参照と退会だけは許す (対象を指定しない、または自分を指定した場合)。
  if (name === "user.get") return payloadUserId(payload) === userId;
  if (name === "user.delete_account") {
    const target = payloadUserId(payload);
    return target === undefined || target === userId;
  }
  return false;
}
