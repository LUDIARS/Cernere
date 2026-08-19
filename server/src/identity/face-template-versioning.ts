/**
 * テンプレート version の採番。
 *
 * 既存行と tombstone の両方の最大値 +1 を採る。削除済みの version を再利用すると
 * 配布先 (Ostiarius) が「古い tombstone で新しいテンプレートを消す」事故を起こすため。
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import type { FaceDbClient } from "./face-db-client.js";

/**
 * 同一 user / facility の採番を transaction 内で直列化する。
 * 行がまだ存在しない初回登録でも効くよう、行ロックではなく transaction-scoped
 * advisory lock を使う。呼び出し側は必ず transaction の client を渡すこと。
 */
export async function lockFaceTemplateVersion(
  userId: string,
  facilityId: string,
  client: FaceDbClient,
): Promise<void> {
  const lockName = `face-template:${userId}:${facilityId}`;
  await client.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockName}, 0))`);
}

export async function nextFaceTemplateVersion(
  userId: string,
  facilityId: string,
  client: FaceDbClient = db,
): Promise<number> {
  const existing = await client.select({ version: schema.faceTemplates.version })
    .from(schema.faceTemplates)
    .where(and(eq(schema.faceTemplates.userId, userId), eq(schema.faceTemplates.facilityId, facilityId)))
    .limit(1);
  const tombstone = await client.select({ version: schema.faceTemplateTombstones.version })
    .from(schema.faceTemplateTombstones)
    .where(and(
      eq(schema.faceTemplateTombstones.userId, userId),
      eq(schema.faceTemplateTombstones.facilityId, facilityId),
    ))
    .orderBy(desc(schema.faceTemplateTombstones.version))
    .limit(1);
  return Math.max(existing[0]?.version ?? 0, tombstone[0]?.version ?? 0) + 1;
}
