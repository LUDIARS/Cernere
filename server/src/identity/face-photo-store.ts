/**
 * プロフィール顔写真の保存・取得・削除と、写真由来 pending テンプレートの審査。
 *
 * 方針:
 *   - 写真は 1 人 1 枚。表示用に長辺 1024 / JPEG へ正規化してから封緘する。
 *   - 抽出に使ったフレームと平文の埋め込みは保持しない。
 *   - 写真から作ったテンプレートは必ず state='pending'。職員が promote するまで
 *     export に出ない = 照合経路に乗らない。
 *   - 鍵 / sidecar が未設定なら 503 で fail closed。
 */

import crypto from "node:crypto";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import {
  PHOTO_ACCEPTED_VERSIONS,
  RECONSENT_DAYS,
  requireActiveConsent,
  requireFaceReviewer,
  requireFacilityMembership,
} from "./face-consent-guard.js";
import { isFacePhotoKeyConfigured, openFacePhoto, sealFacePhoto } from "./face-photo-crypto.js";
import { assertAcceptedInputMime, normalizeForStorage, shrinkForExtraction } from "./face-photo-image.js";
import { extractFaceEmbedding, isFaceSidecarConfigured } from "./face-sidecar-client.js";
import { lockFaceTemplateVersion, nextFaceTemplateVersion } from "./face-template-versioning.js";
import { sealStoredFaceTemplate } from "./face-template-crypto.js";
import {
  deleteFacePhotosForConsents,
  deleteFacePhotosForUsers,
} from "./face-photo-deletion.js";
import { lockFacePhotoMutation } from "./face-photo-lock.js";
import type { FaceDbClient } from "./face-db-client.js";

export type TemplateState = "pending" | "active" | "revoked";
export type PromoteMode = "reenroll" | "promote-photo";

export interface SavedFacePhoto {
  width: number;
  height: number;
  byteSize: number;
  templateState: TemplateState;
  version: number;
}

function requirePhotoPipeline(): void {
  if (!isFacePhotoKeyConfigured()) {
    throw AppError.serviceUnavailable("Face photo storage key is not configured");
  }
  if (!isFaceSidecarConfigured()) {
    throw AppError.serviceUnavailable("Face sidecar is not configured");
  }
}

/**
 * 写真を保存し、同じ同意に紐付く pending テンプレートを upsert する。
 * 顔が取れなければ 422 で終わり、写真も保存しない (DB 書き込みより前に抽出する)。
 */
export async function saveFacePhoto(input: {
  userId: string;
  facilityId: string;
  image: Buffer;
  mime: string;
}): Promise<SavedFacePhoto> {
  requirePhotoPipeline();
  assertAcceptedInputMime(input.mime);
  // 高コストな画像処理の前に早期拒否し、保存直前にも transaction 内で再検証する。
  await requireFacilityMembership(input.userId, input.facilityId);
  await requireActiveConsent(input.userId, input.facilityId, {
    versions: PHOTO_ACCEPTED_VERSIONS,
  });

  const normalized = await normalizeForStorage(input.image);
  try {
    // 抽出用フレームは sidecar へ渡すだけで保持しない。
    const extraction = await (async () => {
      const frame = await shrinkForExtraction(normalized.bytes);
      try {
        return await extractFaceEmbedding(frame, normalized.mime);
      } finally {
        if (frame !== normalized.bytes) frame.fill(0);
      }
    })();

    const template = extraction.embedding;
    try {
      if (template.length === 0) throw AppError.unprocessable("no_face_detected");
      return await db.transaction(async (tx) => {
        await lockFacePhotoMutation(input.userId, tx);
        // 抽出中に所属離脱・同意撤回が完了していたら、古い事前確認を使って保存しない。
        await requireFacilityMembership(input.userId, input.facilityId, tx);
        const consent = await requireActiveConsent(input.userId, input.facilityId, {
          versions: PHOTO_ACCEPTED_VERSIONS,
          client: tx,
        });
        await lockFaceTemplateVersion(input.userId, input.facilityId, tx);
        const version = await nextFaceTemplateVersion(input.userId, input.facilityId, tx);
        const context = {
          userId: input.userId,
          facilityId: input.facilityId,
          modelId: extraction.modelId,
          version,
        };
        const templateEnc = sealStoredFaceTemplate(template, context);
        const sealed = sealFacePhoto(normalized.bytes, {
          userId: input.userId,
          consentId: consent.id,
          mime: normalized.mime,
        });
        const now = new Date();

        const existingPhoto = await tx.select({ id: schema.facePhotos.id })
          .from(schema.facePhotos).where(eq(schema.facePhotos.userId, input.userId)).limit(1);
        const photoRow = {
          ciphertext: sealed.ciphertext,
          iv: sealed.iv,
          tag: sealed.tag,
          keyId: sealed.keyId,
          mime: normalized.mime,
          width: normalized.width,
          height: normalized.height,
          byteSize: normalized.bytes.length,
          consentId: consent.id,
          updatedAt: now,
        };
        if (existingPhoto[0]) {
          await tx.update(schema.facePhotos).set(photoRow)
            .where(eq(schema.facePhotos.userId, input.userId));
        } else {
          await tx.insert(schema.facePhotos).values({
            id: crypto.randomUUID(),
            userId: input.userId,
            createdAt: now,
            ...photoRow,
          });
        }

        const templateRow = {
          templateEnc,
          keyId: "storage:v1",
          modelId: extraction.modelId,
          quality: extraction.quality,
          version,
          facilityId: input.facilityId,
          consentId: consent.id,
          state: "pending",
          revokedAt: null,
          createdAt: now,
        };
        const existingTemplate = await tx.select({ id: schema.faceTemplates.id })
          .from(schema.faceTemplates)
          .where(and(
            eq(schema.faceTemplates.userId, input.userId),
            eq(schema.faceTemplates.facilityId, input.facilityId),
          ))
          .limit(1);
        if (existingTemplate[0]) {
          await tx.update(schema.faceTemplates).set(templateRow)
            .where(eq(schema.faceTemplates.id, existingTemplate[0].id));
        } else {
          await tx.insert(schema.faceTemplates).values({
            id: crypto.randomUUID(),
            userId: input.userId,
            enrolledBy: null,
            ...templateRow,
          });
        }

        return {
          width: normalized.width,
          height: normalized.height,
          byteSize: normalized.bytes.length,
          templateState: "pending" as const,
          version,
        };
      });
    } finally {
      template.fill(0);
    }
  } finally {
    normalized.bytes.fill(0);
  }
}

/** 1 件だけ返す。一括取得の口は作らない。 */
export async function readFacePhoto(userId: string): Promise<{ bytes: Buffer; mime: string }> {
  if (!isFacePhotoKeyConfigured()) {
    throw AppError.serviceUnavailable("Face photo storage key is not configured");
  }
  const cutoff = new Date(Date.now() - RECONSENT_DAYS * 86400000);
  const rows = await db.select({
    userId: schema.facePhotos.userId,
    ciphertext: schema.facePhotos.ciphertext,
    iv: schema.facePhotos.iv,
    tag: schema.facePhotos.tag,
    keyId: schema.facePhotos.keyId,
    mime: schema.facePhotos.mime,
    consentId: schema.facePhotos.consentId,
  }).from(schema.facePhotos)
    .innerJoin(schema.faceConsents, eq(schema.facePhotos.consentId, schema.faceConsents.id))
    .innerJoin(schema.organizationMembers, and(
      eq(schema.organizationMembers.userId, schema.facePhotos.userId),
      eq(schema.organizationMembers.organizationId, schema.faceConsents.facilityId),
    ))
    .where(and(
      eq(schema.facePhotos.userId, userId),
      inArray(schema.faceConsents.policyVersion, [...PHOTO_ACCEPTED_VERSIONS]),
      isNull(schema.faceConsents.revokedAt),
      gt(schema.faceConsents.at, cutoff),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) throw AppError.notFound("Face photo not found");
  const bytes = openFacePhoto(
    {
      ciphertext: Buffer.from(row.ciphertext),
      iv: Buffer.from(row.iv),
      tag: Buffer.from(row.tag),
      keyId: row.keyId,
    },
    { userId: row.userId, consentId: row.consentId, mime: row.mime },
  );
  return { bytes, mime: row.mime };
}

/**
 * 写真と、それに紐付くテンプレート (pending / active) を同一トランザクションで削除し、
 * tombstone を残す。写真だけ・テンプレートだけが残る中間状態を作らない。
 */
export async function deleteFacePhoto(userId: string, reason: string): Promise<{ ok: true; removedTemplates: number }> {
  return db.transaction(async (tx) => {
    await lockFacePhotoMutation(userId, tx);
    const templates = await tx.select().from(schema.faceTemplates)
      .where(eq(schema.faceTemplates.userId, userId));
    const now = new Date();
    for (const row of templates) {
      await tx.delete(schema.faceTemplates).where(eq(schema.faceTemplates.id, row.id));
      await tx.insert(schema.faceTemplateTombstones).values({
        id: crypto.randomUUID(),
        userId,
        facilityId: row.facilityId,
        version: row.version,
        revokedAt: now,
        reason,
      });
    }
    await deleteFacePhotosForUsers(tx, [userId]);
    return { ok: true as const, removedTemplates: templates.length };
  });
}

async function requireTemplate(
  userId: string,
  facilityId: string,
  client: FaceDbClient = db,
) {
  const rows = await client.select().from(schema.faceTemplates)
    .where(and(
      eq(schema.faceTemplates.userId, userId),
      eq(schema.faceTemplates.facilityId, facilityId),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) throw AppError.notFound("Face template not found");
  return row;
}

/**
 * 審査通過。
 *   - 'reenroll'      : Ostiarius が撮り直した template を PUT した後に呼ぶ既定経路。
 *                       現行行 (= 新ショット) を active にし、種にした写真は破棄する。
 *   - 'promote-photo' : 写真由来の pending をそのまま active にする。
 */
export async function promoteFaceTemplate(input: {
  userId: string;
  facilityId: string;
  enrolledBy: string;
  mode: PromoteMode;
}): Promise<{ ok: true; state: TemplateState; version: number }> {
  return db.transaction(async (tx) => {
    await lockFacePhotoMutation(input.userId, tx);
    await requireFaceReviewer(input.enrolledBy, input.facilityId, tx);
    await requireFacilityMembership(input.userId, input.facilityId, tx);
    await requireActiveConsent(input.userId, input.facilityId, { client: tx });
    const template = await requireTemplate(input.userId, input.facilityId, tx);
    if (input.mode === "reenroll" && template.state !== "active") {
      throw AppError.conflict("Re-enrollment template is not active");
    }
    if (input.mode === "promote-photo" && template.state !== "pending") {
      throw AppError.conflict("Photo template is not pending");
    }
    await tx.update(schema.faceTemplates)
      .set({ state: "active", enrolledBy: input.enrolledBy })
      .where(eq(schema.faceTemplates.id, template.id));
    // 撮り直し経路では種にした写真を保持し続ける理由が無いので落とす。
    if (input.mode === "reenroll") {
      await deleteFacePhotosForConsents(tx, [template.consentId]);
    }
    return { ok: true as const, state: "active" as const, version: template.version };
  });
}

/** 却下。pending テンプレートと写真を同時に消し、理由を tombstone に残す。 */
export async function rejectFaceTemplate(input: {
  userId: string;
  facilityId: string;
  enrolledBy: string;
  reason: string;
}): Promise<{ ok: true; removedTemplates: number }> {
  return db.transaction(async (tx) => {
    await lockFacePhotoMutation(input.userId, tx);
    await requireFaceReviewer(input.enrolledBy, input.facilityId, tx);
    const template = await requireTemplate(input.userId, input.facilityId, tx);
    if (template.state === "active") throw AppError.conflict("Template is already active");
    const now = new Date();
    await tx.delete(schema.faceTemplates).where(eq(schema.faceTemplates.id, template.id));
    await tx.insert(schema.faceTemplateTombstones).values({
      id: crypto.randomUUID(),
      userId: input.userId,
      facilityId: input.facilityId,
      version: template.version,
      revokedAt: now,
      reason: input.reason,
    });
    await deleteFacePhotosForConsents(tx, [template.consentId]);
    return { ok: true as const, removedTemplates: 1 };
  });
}
