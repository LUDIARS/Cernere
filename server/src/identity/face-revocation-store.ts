/**
 * 失効指示 (face_revocations) の積み上げと配布。
 *
 * 顔テンプレート・顔写真の正本は施設の kiosk ホスト (Ostiarius) にあり、Cernere は
 * 「この user の登録を消せ」という指示だけを持つ。Ostiarius が 15 分ごと (+ 職員の
 * 即時 sync) に pull して物理削除する。
 *
 * ここに生体情報 (テンプレート・写真・氏名) を載せてはならない。積むのは
 * userId / facilityId / reason / at の 4 つだけ。
 */

import crypto from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import type { FaceDbClient } from "./face-db-client.js";

/** 失効指示の理由。Ostiarius の削除判断と監査のための分類で、追加は契約変更。 */
export const FACE_REVOCATION_REASONS = [
  "withdrawn",
  "left_facility",
  "graduated",
  "account_deleted",
  "consent_expired",
  "staff_invalidated",
] as const;
export type FaceRevocationReason = typeof FACE_REVOCATION_REASONS[number];

/** 失効指示の保持日数。Ostiarius のバックアップ復元もこの窓内で全量適用する。 */
export const REVOCATION_RETENTION_DAYS = 30;

export interface FaceRevocationTarget {
  userId: string;
  facilityId: string;
}

export function isFaceRevocationReason(value: string): value is FaceRevocationReason {
  return (FACE_REVOCATION_REASONS as readonly string[]).includes(value);
}

function retentionCutoff(now = new Date()): Date {
  return new Date(now.getTime() - REVOCATION_RETENTION_DAYS * 86400000);
}

/**
 * 失効指示を 1 行ずつ積む。同じ user / facility / reason が複数回来ても
 * 冪等化しない: Ostiarius 側は削除を繰り返しても結果が同じで、
 * 「いつ指示が出たか」は監査の情報だから残す。
 */
export async function appendFaceRevocations(
  client: FaceDbClient,
  targets: FaceRevocationTarget[],
  reason: FaceRevocationReason,
  at = new Date(),
): Promise<number> {
  const unique = new Map<string, FaceRevocationTarget>();
  for (const target of targets) {
    if (!target.userId || !target.facilityId) continue;
    unique.set(`${target.userId}:${target.facilityId}`, target);
  }
  for (const target of unique.values()) {
    await client.insert(schema.faceRevocations).values({
      id: crypto.randomUUID(),
      userId: target.userId,
      facilityId: target.facilityId,
      reason,
      at,
    });
  }
  return unique.size;
}

export interface FaceRevocationRow {
  userId: string;
  facilityId: string;
  reason: string;
  at: string;
}

/**
 * 施設単位で失効指示を返す。`since` は保持期間内へ丸める:
 * それより前の指示は既に回収済みで、「無い = 削除不要」と誤解させないため。
 */
export async function listFaceRevocations(
  facilityId: string,
  since?: Date,
): Promise<FaceRevocationRow[]> {
  await purgeExpiredFaceRevocations();
  const cutoff = retentionCutoff();
  const from = since && since > cutoff ? since : cutoff;
  const rows = await db.select({
    userId: schema.faceRevocations.userId,
    facilityId: schema.faceRevocations.facilityId,
    reason: schema.faceRevocations.reason,
    at: schema.faceRevocations.at,
  }).from(schema.faceRevocations)
    .where(and(eq(schema.faceRevocations.facilityId, facilityId), gt(schema.faceRevocations.at, from)))
    .orderBy(schema.faceRevocations.at);
  return rows.map((row) => ({ ...row, at: row.at.toISOString() }));
}

/** 30 日を超えた失効指示を回収する。起動時と配布時に呼ぶ。 */
export async function purgeExpiredFaceRevocations(now = new Date()): Promise<void> {
  await db.delete(schema.faceRevocations).where(lt(schema.faceRevocations.at, retentionCutoff(now)));
}
