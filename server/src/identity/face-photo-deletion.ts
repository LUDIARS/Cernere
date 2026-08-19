/**
 * 写真の削除だけを担う最小モジュール。
 *
 * face-template-store の失効経路 (本人撤回 / 所属離脱 / 施設削除 / アカウント削除 /
 * 同意期限切れ) から呼ばれ、**テンプレートだけ消えて写真が残る経路をゼロにする**。
 * face-photo-store から import すると循環するため、ここに分離している。
 */

import { inArray } from "drizzle-orm";
import * as schema from "../db/schema.js";
import type { FaceDbClient } from "./face-db-client.js";

/** 指定ユーザーの顔写真を削除する。写真は 1 人 1 枚で施設に紐付かない。 */
export async function deleteFacePhotosForUsers(client: FaceDbClient, userIds: string[]): Promise<number> {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (unique.length === 0) return 0;
  await client.delete(schema.facePhotos).where(inArray(schema.facePhotos.userId, unique));
  return unique.length;
}

/**
 * 指定同意に直接紐付く写真だけを削除する。
 * 写真は user 単位で 1 枚だが同意は施設単位なので、施設 A の撤回で施設 B の
 * 同意に紐付くプロフィール写真まで消さないために consent_id で絞る。
 */
export async function deleteFacePhotosForConsents(
  client: FaceDbClient,
  consentIds: string[],
): Promise<number> {
  const unique = [...new Set(consentIds)].filter(Boolean);
  if (unique.length === 0) return 0;
  await client.delete(schema.facePhotos).where(inArray(schema.facePhotos.consentId, unique));
  return unique.length;
}
