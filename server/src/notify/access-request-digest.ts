/**
 * 審査待ちの利用申請を admin へまとめて知らせる (許可制 案 A)。
 *
 * 登録・申請 1 件ごとには通知しない (大量登録で admin の通知を埋めさせない)。一定間隔で、
 * 前回以降に増えた未決の申請があれば、active な admin ごとに件数だけを出来事として記録する。
 * 配送は通常の outbox (他セッション・確認済みの Discord / Google) に乗る。
 */

import { and, eq, gt, sql } from "drizzle-orm";

import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { devError } from "../logging/dev-logger.js";
import { recordSecurityEvent } from "./security-events.js";

const DIGEST_INTERVAL_MS = 15 * 60 * 1000;

let lastDigestAt = new Date();
let timer: NodeJS.Timeout | null = null;

/** 1 回分。前回以降に新しい申請があれば、未決の総数を admin に知らせる。知らせた admin の数を返す。 */
export async function sendAccessRequestDigestOnce(now = new Date()): Promise<number> {
  const since = lastDigestAt;
  lastDigestAt = now;
  const fresh = await db.select({ count: sql<number>`count(*)` }).from(schema.registrationRequests).where(and(
    eq(schema.registrationRequests.state, "open"),
    gt(schema.registrationRequests.createdAt, since),
  ));
  if (Number(fresh[0]?.count ?? 0) === 0) return 0;
  const open = await db.select({ count: sql<number>`count(*)` }).from(schema.registrationRequests)
    .where(eq(schema.registrationRequests.state, "open"));
  const admins = await db.select({ id: schema.users.id }).from(schema.users).where(and(
    eq(schema.users.role, "admin"),
    eq(schema.users.accessStatus, "active"),
  ));
  const count = Number(open[0]?.count ?? 0);
  for (const admin of admins) {
    await db.transaction((tx) => recordSecurityEvent(tx, admin.id, "access.requests_pending", { count }));
  }
  return admins.length;
}

export function startAccessRequestDigest(): void {
  if (timer) return;
  timer = setInterval(() => {
    sendAccessRequestDigestOnce().catch((err) => devError("notify.accessDigest.failed", err, {}));
  }, DIGEST_INTERVAL_MS);
  timer.unref();
}
