/**
 * 本人のセキュリティ上の出来事の履歴 (WS module "security_event")。
 * relay の即時表示は接続中のセッションにしか届かないため、後からログインした本人が
 * 「心当たりのない出来事」に気づけるよう /security 画面がここから読む (SPEC-LOGIN-ALERT)。
 */

import { desc, eq } from "drizzle-orm";

import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";

const LIST_LIMIT = 50;

export async function securityEventCommand(userId: string, action: string): Promise<unknown> {
  if (action !== "list") throw AppError.badRequest("Unknown security_event action");
  const rows = await db.select({
    id: schema.securityEvents.id,
    kind: schema.securityEvents.kind,
    severity: schema.securityEvents.severity,
    detail: schema.securityEvents.detail,
    createdAt: schema.securityEvents.createdAt,
  }).from(schema.securityEvents)
    .where(eq(schema.securityEvents.userId, userId))
    .orderBy(desc(schema.securityEvents.createdAt))
    .limit(LIST_LIMIT);
  return { events: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) };
}
