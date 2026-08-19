/**
 * 顔写真を新しい同意へ付け替える処理。
 *
 * consent_id は AES-GCM の AAD に含まれるため、DB の外部キーだけを更新すると
 * 以後の復号が必ず失敗する。旧 AAD で開封し、新 AAD で再封緘してから同一
 * transaction 内で置き換える。
 */

import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../db/schema.js";
import type { FaceDbClient } from "./face-db-client.js";
import { openFacePhoto, sealFacePhoto } from "./face-photo-crypto.js";

export async function rebindFacePhotoConsent(
  client: FaceDbClient,
  userId: string,
  previousConsentIds: string[],
  nextConsentId: string,
): Promise<void> {
  const previous = [...new Set(previousConsentIds)].filter(Boolean);
  if (previous.length === 0) return;

  const rows = await client.select().from(schema.facePhotos)
    .where(and(
      eq(schema.facePhotos.userId, userId),
      inArray(schema.facePhotos.consentId, previous),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) return;

  const plain = openFacePhoto(
    {
      ciphertext: Buffer.from(row.ciphertext),
      iv: Buffer.from(row.iv),
      tag: Buffer.from(row.tag),
      keyId: row.keyId,
    },
    { userId: row.userId, consentId: row.consentId, mime: row.mime },
  );
  try {
    const resealed = sealFacePhoto(plain, {
      userId: row.userId,
      consentId: nextConsentId,
      mime: row.mime,
    });
    await client.update(schema.facePhotos).set({
      ciphertext: resealed.ciphertext,
      iv: resealed.iv,
      tag: resealed.tag,
      keyId: resealed.keyId,
      consentId: nextConsentId,
      updatedAt: new Date(),
    }).where(eq(schema.facePhotos.id, row.id));
  } finally {
    plain.fill(0);
  }
}
