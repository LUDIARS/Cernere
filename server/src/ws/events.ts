/**
 * 組織内イベント配信
 *
 * 組織メンバー全員にリアルタイムイベントをプッシュする。
 */

import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { eq } from "drizzle-orm";
import { sessionRegistry } from "./session-registry.js";
import type { ServerMessage } from "./protocol.js";

/** 組織メンバーの userId 一覧を取得 */
async function getOrgMemberIds(orgId: string): Promise<string[]> {
  const rows = await db.select({ userId: schema.organizationMembers.userId })
    .from(schema.organizationMembers)
    .where(eq(schema.organizationMembers.organizationId, orgId));
  return rows.map((r) => r.userId);
}

/** 組織メンバー全員にイベントをプッシュ */
export async function pushOrgEvent(
  orgId: string,
  event: string,
  payload: unknown,
  excludeUserId?: string,
): Promise<void> {
  const memberIds = await getOrgMemberIds(orgId);
  const msg: ServerMessage = { type: "event", event, payload };
  sessionRegistry.broadcastToUsers(memberIds, msg, excludeUserId);
}

/** ユーザーのプレゼンス情報を組織メンバーに通知 */
export async function notifyPresenceChange(
  userId: string,
  status: "online" | "offline",
): Promise<void> {
  // ユーザーが所属する全組織に通知
  const memberships = await db.select({ orgId: schema.organizationMembers.organizationId })
    .from(schema.organizationMembers)
    .where(eq(schema.organizationMembers.userId, userId));

  const userRow = await db.select({ displayName: schema.users.displayName })
    .from(schema.users).where(eq(schema.users.id, userId)).limit(1);

  const payload = {
    userId,
    displayName: userRow[0]?.displayName ?? "",
    status,
    timestamp: new Date().toISOString(),
  };

  for (const m of memberships) {
    await pushOrgEvent(m.orgId, "member.presence", payload, userId);
  }
}

/** 組織メンバーのオンライン状態一覧を返す */
export async function getOrgPresence(orgId: string): Promise<Array<{ userId: string; online: boolean }>> {
  const memberIds = await getOrgMemberIds(orgId);
  return memberIds.map((uid) => ({
    userId: uid,
    online: sessionRegistry.isOnline(uid),
  }));
}
