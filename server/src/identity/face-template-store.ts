import crypto from "node:crypto";
import { and, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { AppError } from "../error.js";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import {
  createFaceTemplateDistributor,
  openStoredFaceTemplate,
  sealStoredFaceTemplate,
} from "./face-template-crypto.js";
import {
  CURRENT_POLICY_VERSION,
  PHOTO_POLICY_VERSION,
  RECONSENT_DAYS,
  TEMPLATE_ACCEPTED_VERSIONS,
  TEMPLATE_POLICY_VERSION,
  TOMBSTONE_DAYS,
  isKnownPolicyVersion,
  requireFaceReviewer,
  requireFacilityMembership,
} from "./face-consent-guard.js";
import { lockFaceTemplateVersion, nextFaceTemplateVersion } from "./face-template-versioning.js";
import {
  deleteFacePhotosForConsents,
  deleteFacePhotosForUsers,
} from "./face-photo-deletion.js";
import { rebindFacePhotoConsent } from "./face-photo-consent.js";
import { lockFacePhotoMutation, lockFacePhotoMutations } from "./face-photo-lock.js";

/**
 * 同意文面は版ごとに保持する。GLab / Ostiarius の同意画面は
 * GET /api/identity/face-consent/policy から版と文面を取得して表示する契約。
 */
export const faceConsentPolicies = [
  {
    version: TEMPLATE_POLICY_VERSION,
    requiredFor: ["face-template"],
    text: "顔認証では顔写真を保存せず、暗号化した特徴テンプレートのみを在籍中かつ同意から365日まで保持します。プロフィールからいつでも撤回できます。",
  },
  {
    version: PHOTO_POLICY_VERSION,
    requiredFor: ["face-template", "face-photo"],
    text: "顔認証のために、プロフィール顔写真を1枚だけ暗号化して保存します。写真は職員の名簿・出席確認画面と本人のプロフィールでのみ表示し、受付端末 (kiosk) には表示しません。写真から作った特徴テンプレートは、職員が本人確認して承認するまで出席の照合には使いません。写真と特徴テンプレートは在籍中かつ同意から365日まで保持し、プロフィールからの削除操作または同意の撤回で、写真とテンプレートを同時に削除します。",
  },
] as const;

export const faceConsentPolicy = {
  version: CURRENT_POLICY_VERSION,
  text: faceConsentPolicies.find((policy) => policy.version === CURRENT_POLICY_VERSION)?.text ?? "",
  policies: faceConsentPolicies,
};

export async function createFaceConsent(userId: string, policyVersion: string, facilityId: string) {
  if (!isKnownPolicyVersion(policyVersion)) {
    throw AppError.conflict("current_policy_consent_required");
  }
  await requireFacilityMembership(userId, facilityId);
  const at = new Date();
  const consentId = await db.transaction(async (tx) => {
    await lockFacePhotoMutation(userId, tx);
    // 事前確認と lock 取得の間に所属解除されていないことを保存直前に確かめる。
    await requireFacilityMembership(userId, facilityId, tx);
    const active = await tx.select({
      id: schema.faceConsents.id,
      policyVersion: schema.faceConsents.policyVersion,
    })
      .from(schema.faceConsents)
      .where(and(
        eq(schema.faceConsents.userId, userId),
        eq(schema.faceConsents.facilityId, facilityId),
        isNull(schema.faceConsents.revokedAt),
      ));
    const current = active.find((consent) => consent.policyVersion === policyVersion);
    if (current) {
      await tx.update(schema.faceConsents).set({ at })
        .where(eq(schema.faceConsents.id, current.id));
      return current.id;
    }
    await tx.update(schema.faceConsents).set({ revokedAt: at }).where(and(
      eq(schema.faceConsents.userId, userId),
      eq(schema.faceConsents.facilityId, facilityId),
      isNull(schema.faceConsents.revokedAt),
    ));
    const id = crypto.randomUUID();
    await tx.insert(schema.faceConsents).values({ id, userId, policyVersion, facilityId, at });
    // 版を切り替えると旧同意は撤回済みになる。テンプレートは新同意へ付け替える。
    await tx.update(schema.faceTemplates).set({ consentId: id }).where(and(
      eq(schema.faceTemplates.userId, userId),
      eq(schema.faceTemplates.facilityId, facilityId),
    ));
    const previousConsentIds = active.map((consent) => consent.id);
    if (policyVersion === PHOTO_POLICY_VERSION) {
      // 写真を保持できる版同士の移行では、consentId を含む AAD も新 ID で再封緘する。
      await rebindFacePhotoConsent(tx, userId, previousConsentIds, id);
    } else {
      // template-only 版への切替では「写真を保存しない」という選択を即時反映する。
      await deleteFacePhotosForConsents(tx, previousConsentIds);
    }
    return id;
  });
  return { consentId, at: at.toISOString() };
}

export async function putFaceTemplate(input: { userId: string; template: string; modelId: string; quality: number; facilityId: string; enrolledBy: string; consentId: string }) {
  const template = Buffer.from(input.template, "base64");
  if (template.length === 0 || template.toString("base64") !== input.template) throw AppError.badRequest("Invalid face template request");
  try {
    return db.transaction(async (tx) => {
      await lockFacePhotoMutation(input.userId, tx);
      await requireFacilityMembership(input.userId, input.facilityId, tx);
      await requireFaceReviewer(input.enrolledBy, input.facilityId, tx);
      const consent = await tx.select().from(schema.faceConsents).where(and(eq(schema.faceConsents.id, input.consentId), eq(schema.faceConsents.userId, input.userId), eq(schema.faceConsents.facilityId, input.facilityId), inArray(schema.faceConsents.policyVersion, [...TEMPLATE_ACCEPTED_VERSIONS]), isNull(schema.faceConsents.revokedAt))).limit(1);
      if (consent.length === 0 || consent[0].at < new Date(Date.now() - RECONSENT_DAYS * 86400000)) throw AppError.conflict("consent_required");
      await lockFaceTemplateVersion(input.userId, input.facilityId, tx);
      const existing = await tx.select({ id: schema.faceTemplates.id })
        .from(schema.faceTemplates)
        .where(and(
          eq(schema.faceTemplates.userId, input.userId),
          eq(schema.faceTemplates.facilityId, input.facilityId),
        ))
        .limit(1);
      const version = await nextFaceTemplateVersion(input.userId, input.facilityId, tx);
      const context = { userId: input.userId, facilityId: input.facilityId, modelId: input.modelId, version };
      const templateEnc = sealStoredFaceTemplate(template, context);
      // 職員が撮った (= 審査済みの) テンプレートなので state='active'。写真由来の
      // pending が残っていればここで上書きされる。
      const record = { templateEnc, keyId: "storage:v1", modelId: input.modelId, quality: Math.round(input.quality), version, facilityId: input.facilityId, enrolledBy: input.enrolledBy, consentId: input.consentId, state: "active", revokedAt: null, createdAt: new Date() };
      if (existing[0]) {
        await tx.update(schema.faceTemplates).set(record)
          .where(eq(schema.faceTemplates.id, existing[0].id));
      } else {
        await tx.insert(schema.faceTemplates).values({
          id: crypto.randomUUID(),
          userId: input.userId,
          ...record,
        });
      }
      return { version };
    });
  } finally {
    template.fill(0);
  }
}

export async function revokeFaceTemplates(userId: string, facilityId: string | undefined, reason: string, revokeConsent: boolean) {
  return db.transaction(async (tx) => {
    await lockFacePhotoMutation(userId, tx);
    const rows = await tx.select().from(schema.faceTemplates).where(facilityId ? and(eq(schema.faceTemplates.userId, userId), eq(schema.faceTemplates.facilityId, facilityId), isNull(schema.faceTemplates.revokedAt)) : and(eq(schema.faceTemplates.userId, userId), isNull(schema.faceTemplates.revokedAt)));
    const consents = revokeConsent
      ? await tx.select({ id: schema.faceConsents.id }).from(schema.faceConsents).where(facilityId ? and(eq(schema.faceConsents.userId, userId), eq(schema.faceConsents.facilityId, facilityId), isNull(schema.faceConsents.revokedAt)) : and(eq(schema.faceConsents.userId, userId), isNull(schema.faceConsents.revokedAt)))
      : [];
    const now = new Date();
    for (const row of rows) {
      await tx.delete(schema.faceTemplates).where(eq(schema.faceTemplates.id, row.id));
      await tx.insert(schema.faceTemplateTombstones).values({ id: crypto.randomUUID(), userId, facilityId: row.facilityId, version: row.version, revokedAt: now, reason });
    }
    if (facilityId) {
      await deleteFacePhotosForConsents(tx, [
        ...rows.map((row) => row.consentId),
        ...consents.map((consent) => consent.id),
      ]);
    } else {
      await deleteFacePhotosForUsers(tx, [userId]);
    }
    if (revokeConsent) await tx.update(schema.faceConsents).set({ revokedAt: now }).where(facilityId ? and(eq(schema.faceConsents.userId, userId), eq(schema.faceConsents.facilityId, facilityId), isNull(schema.faceConsents.revokedAt)) : and(eq(schema.faceConsents.userId, userId), isNull(schema.faceConsents.revokedAt)));
    return { ok: true, removed: rows.length };
  });
}

export async function exportFaceTemplates(facilityId: string) {
  await purgeExpiredFaceTemplates({ facilityId });
  const cutoff = new Date(Date.now() - RECONSENT_DAYS * 86400000);
  const active = await db.select().from(schema.faceTemplates)
    .innerJoin(schema.faceConsents, eq(schema.faceTemplates.consentId, schema.faceConsents.id))
    .innerJoin(schema.organizationMembers, and(
      eq(schema.organizationMembers.userId, schema.faceTemplates.userId),
      eq(schema.organizationMembers.organizationId, schema.faceTemplates.facilityId),
    ))
    .where(and(eq(schema.faceTemplates.facilityId, facilityId), eq(schema.faceTemplates.state, "active"), inArray(schema.faceConsents.policyVersion, [...TEMPLATE_ACCEPTED_VERSIONS]), isNull(schema.faceTemplates.revokedAt), isNull(schema.faceConsents.revokedAt), gt(schema.faceConsents.at, cutoff)));
  // 空の export でも配布鍵が無ければ fail-closed にする。
  const distributor = createFaceTemplateDistributor(facilityId);
  const templates = active.map(({ face_templates: row }) => {
    const context = { userId: row.userId, facilityId: row.facilityId, modelId: row.modelId, version: row.version };
    const plain = openStoredFaceTemplate(Buffer.from(row.templateEnc), context);
    try {
      return { userId: row.userId, template: distributor.seal(plain).toString("base64"), keyId: distributor.keyId, modelId: row.modelId, quality: row.quality, version: row.version, state: row.state, enrolledAt: row.createdAt.toISOString(), revoked: false };
    } finally {
      plain.fill(0);
    }
  });
  const tombstoneCutoff = new Date(Date.now() - TOMBSTONE_DAYS * 86400000);
  const revoked = await db.select({ userId: schema.faceTemplateTombstones.userId, version: schema.faceTemplateTombstones.version }).from(schema.faceTemplateTombstones).where(and(eq(schema.faceTemplateTombstones.facilityId, facilityId), gt(schema.faceTemplateTombstones.revokedAt, tombstoneCutoff)));
  return { modelId: templates[0]?.modelId ?? null, templates, revoked };
}

export async function listFaceTemplateStatus(userId: string) {
  await purgeExpiredFaceTemplates({ userId });
  const cutoff = new Date(Date.now() - RECONSENT_DAYS * 86400000);
  const rows = await db.select({ facilityId: schema.faceTemplates.facilityId, modelId: schema.faceTemplates.modelId, version: schema.faceTemplates.version, state: schema.faceTemplates.state, enrolledAt: schema.faceTemplates.createdAt })
    .from(schema.faceTemplates)
    .innerJoin(schema.faceConsents, eq(schema.faceTemplates.consentId, schema.faceConsents.id))
    .innerJoin(schema.organizationMembers, and(
      eq(schema.organizationMembers.userId, schema.faceTemplates.userId),
      eq(schema.organizationMembers.organizationId, schema.faceTemplates.facilityId),
    ))
    .where(and(eq(schema.faceTemplates.userId, userId), inArray(schema.faceConsents.policyVersion, [...TEMPLATE_ACCEPTED_VERSIONS]), isNull(schema.faceTemplates.revokedAt), isNull(schema.faceConsents.revokedAt), gt(schema.faceConsents.at, cutoff)));
  return { items: rows.map((r) => ({ ...r, enrolledAt: r.enrolledAt.toISOString() })) };
}

export async function purgeExpiredFaceTemplates(scope: { userId?: string; facilityId?: string } = {}) {
  const cutoff = new Date(Date.now() - RECONSENT_DAYS * 86400000);
  const scopeCondition = scope.userId
    ? eq(schema.faceConsents.userId, scope.userId)
    : scope.facilityId
      ? eq(schema.faceConsents.facilityId, scope.facilityId)
      : undefined;
  const now = new Date();
  await db.transaction(async (tx) => {
    const expiredConsents = await tx.select({ id: schema.faceConsents.id })
      .from(schema.faceConsents)
      .where(and(isNull(schema.faceConsents.revokedAt), lt(schema.faceConsents.at, cutoff), scopeCondition));
    const expired = await tx.select({
      id: schema.faceTemplates.id,
      userId: schema.faceTemplates.userId,
      facilityId: schema.faceTemplates.facilityId,
      version: schema.faceTemplates.version,
    }).from(schema.faceTemplates)
      .innerJoin(schema.faceConsents, eq(schema.faceTemplates.consentId, schema.faceConsents.id))
      .where(and(isNull(schema.faceTemplates.revokedAt), isNull(schema.faceConsents.revokedAt), lt(schema.faceConsents.at, cutoff), scopeCondition));
    for (const row of expired) {
      await tx.delete(schema.faceTemplates).where(eq(schema.faceTemplates.id, row.id));
      await tx.insert(schema.faceTemplateTombstones).values({ id: crypto.randomUUID(), userId: row.userId, facilityId: row.facilityId, version: row.version, revokedAt: now, reason: "consent_expired" });
    }
    await deleteFacePhotosForConsents(tx, expiredConsents.map((consent) => consent.id));
    await tx.update(schema.faceConsents).set({ revokedAt: now })
      .where(and(isNull(schema.faceConsents.revokedAt), lt(schema.faceConsents.at, cutoff), scopeCondition));
    if (!scope.userId && !scope.facilityId) {
      await tx.delete(schema.faceTemplateTombstones)
        .where(lt(schema.faceTemplateTombstones.revokedAt, new Date(now.getTime() - TOMBSTONE_DAYS * 86400000)));
    }
  });
}

export async function revokeFacilityFaceTemplates(facilityId: string, reason: string): Promise<number> {
  return db.transaction(async (tx) => {
    // upload / consent mutation と同じ user lock を全所属者分確保してから対象を再取得する。
    const members = await tx.select({ userId: schema.organizationMembers.userId })
      .from(schema.organizationMembers)
      .where(eq(schema.organizationMembers.organizationId, facilityId));
    await lockFacePhotoMutations(members.map((member) => member.userId), tx);
    const templates = await tx.select().from(schema.faceTemplates)
      .where(and(eq(schema.faceTemplates.facilityId, facilityId), isNull(schema.faceTemplates.revokedAt)));
    const consents = await tx.select({ id: schema.faceConsents.id, userId: schema.faceConsents.userId })
      .from(schema.faceConsents)
      .where(and(eq(schema.faceConsents.facilityId, facilityId), isNull(schema.faceConsents.revokedAt)));
    const now = new Date();
    for (const row of templates) {
      await tx.delete(schema.faceTemplates).where(eq(schema.faceTemplates.id, row.id));
      await tx.insert(schema.faceTemplateTombstones).values({ id: crypto.randomUUID(), userId: row.userId, facilityId, version: row.version, revokedAt: now, reason });
    }
    await deleteFacePhotosForConsents(tx, consents.map((consent) => consent.id));
    await tx.update(schema.faceConsents).set({ revokedAt: now })
      .where(and(eq(schema.faceConsents.facilityId, facilityId), isNull(schema.faceConsents.revokedAt)));
    return new Set([...templates, ...consents].map((row) => row.userId)).size;
  });
}
