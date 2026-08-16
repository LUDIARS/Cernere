import crypto from "node:crypto";
import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { AppError } from "../error.js";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import {
  createFaceTemplateDistributor,
  openStoredFaceTemplate,
  sealStoredFaceTemplate,
} from "./face-template-crypto.js";

const POLICY_VERSION = "face-template-v1";
const TOMBSTONE_DAYS = 30;
const RECONSENT_DAYS = 365;

async function requireFacilityMembership(userId: string, facilityId: string): Promise<void> {
  const membership = await db.select({ userId: schema.organizationMembers.userId })
    .from(schema.organizationMembers)
    .where(and(
      eq(schema.organizationMembers.userId, userId),
      eq(schema.organizationMembers.organizationId, facilityId),
    ))
    .limit(1);
  if (membership.length === 0) throw AppError.forbidden("User is not a member of this facility");
}

export const faceConsentPolicy = {
  version: POLICY_VERSION,
  text: "顔認証では顔写真を保存せず、暗号化した特徴テンプレートのみを在籍中かつ同意から365日まで保持します。プロフィールからいつでも撤回できます。",
};

export async function createFaceConsent(userId: string, policyVersion: string, facilityId: string) {
  if (policyVersion !== POLICY_VERSION) throw AppError.conflict("current_policy_consent_required");
  await requireFacilityMembership(userId, facilityId);
  const at = new Date();
  const consentId = await db.transaction(async (tx) => {
    const current = await tx.select({ id: schema.faceConsents.id })
      .from(schema.faceConsents)
      .where(and(
        eq(schema.faceConsents.userId, userId),
        eq(schema.faceConsents.facilityId, facilityId),
        eq(schema.faceConsents.policyVersion, POLICY_VERSION),
        isNull(schema.faceConsents.revokedAt),
      ))
      .limit(1);
    if (current[0]) {
      await tx.update(schema.faceConsents).set({ at })
        .where(eq(schema.faceConsents.id, current[0].id));
      return current[0].id;
    }
    await tx.update(schema.faceConsents).set({ revokedAt: at }).where(and(
      eq(schema.faceConsents.userId, userId),
      eq(schema.faceConsents.facilityId, facilityId),
      isNull(schema.faceConsents.revokedAt),
    ));
    const id = crypto.randomUUID();
    await tx.insert(schema.faceConsents).values({ id, userId, policyVersion, facilityId, at });
    return id;
  });
  return { consentId, at: at.toISOString() };
}

export async function putFaceTemplate(input: { userId: string; template: string; modelId: string; quality: number; facilityId: string; enrolledBy: string; consentId: string }) {
  const template = Buffer.from(input.template, "base64");
  if (template.length === 0 || template.toString("base64") !== input.template) throw AppError.badRequest("Invalid face template request");
  await requireFacilityMembership(input.userId, input.facilityId);
  await requireFacilityMembership(input.enrolledBy, input.facilityId);
  const consent = await db.select().from(schema.faceConsents).where(and(eq(schema.faceConsents.id, input.consentId), eq(schema.faceConsents.userId, input.userId), eq(schema.faceConsents.facilityId, input.facilityId), eq(schema.faceConsents.policyVersion, POLICY_VERSION), isNull(schema.faceConsents.revokedAt))).limit(1);
  if (consent.length === 0 || consent[0].at < new Date(Date.now() - RECONSENT_DAYS * 86400000)) throw AppError.conflict("consent_required");
  const existing = await db.select({ version: schema.faceTemplates.version }).from(schema.faceTemplates).where(and(eq(schema.faceTemplates.userId, input.userId), eq(schema.faceTemplates.facilityId, input.facilityId))).limit(1);
  const latestRevocation = await db.select({ version: schema.faceTemplateTombstones.version })
    .from(schema.faceTemplateTombstones)
    .where(and(
      eq(schema.faceTemplateTombstones.userId, input.userId),
      eq(schema.faceTemplateTombstones.facilityId, input.facilityId),
    ))
    .orderBy(desc(schema.faceTemplateTombstones.version))
    .limit(1);
  const version = Math.max(existing[0]?.version ?? 0, latestRevocation[0]?.version ?? 0) + 1;
  const context = { userId: input.userId, facilityId: input.facilityId, modelId: input.modelId, version };
  const templateEnc = (() => {
    try {
      return sealStoredFaceTemplate(template, context);
    } finally {
      template.fill(0);
    }
  })();
  const record = { id: crypto.randomUUID(), userId: input.userId, templateEnc, keyId: "storage:v1", modelId: input.modelId, quality: Math.round(input.quality), version, facilityId: input.facilityId, enrolledBy: input.enrolledBy, consentId: input.consentId, revokedAt: null, createdAt: new Date() };
  if (existing.length) await db.update(schema.faceTemplates).set(record).where(and(eq(schema.faceTemplates.userId, input.userId), eq(schema.faceTemplates.facilityId, input.facilityId)));
  else await db.insert(schema.faceTemplates).values(record);
  return { version };
}

export async function revokeFaceTemplates(userId: string, facilityId: string | undefined, reason: string, revokeConsent: boolean) {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(schema.faceTemplates).where(facilityId ? and(eq(schema.faceTemplates.userId, userId), eq(schema.faceTemplates.facilityId, facilityId), isNull(schema.faceTemplates.revokedAt)) : and(eq(schema.faceTemplates.userId, userId), isNull(schema.faceTemplates.revokedAt)));
    const now = new Date();
    for (const row of rows) {
      await tx.delete(schema.faceTemplates).where(eq(schema.faceTemplates.id, row.id));
      await tx.insert(schema.faceTemplateTombstones).values({ id: crypto.randomUUID(), userId, facilityId: row.facilityId, version: row.version, revokedAt: now, reason });
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
    .where(and(eq(schema.faceTemplates.facilityId, facilityId), eq(schema.faceConsents.policyVersion, POLICY_VERSION), isNull(schema.faceTemplates.revokedAt), isNull(schema.faceConsents.revokedAt), gt(schema.faceConsents.at, cutoff)));
  // 空の export でも配布鍵が無ければ fail-closed にする。
  const distributor = createFaceTemplateDistributor(facilityId);
  const templates = active.map(({ face_templates: row }) => {
    const context = { userId: row.userId, facilityId: row.facilityId, modelId: row.modelId, version: row.version };
    const plain = openStoredFaceTemplate(Buffer.from(row.templateEnc), context);
    try {
      return { userId: row.userId, template: distributor.seal(plain).toString("base64"), keyId: distributor.keyId, modelId: row.modelId, quality: row.quality, version: row.version, enrolledAt: row.createdAt.toISOString(), revoked: false };
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
  const rows = await db.select({ facilityId: schema.faceTemplates.facilityId, modelId: schema.faceTemplates.modelId, version: schema.faceTemplates.version, enrolledAt: schema.faceTemplates.createdAt })
    .from(schema.faceTemplates)
    .innerJoin(schema.faceConsents, eq(schema.faceTemplates.consentId, schema.faceConsents.id))
    .innerJoin(schema.organizationMembers, and(
      eq(schema.organizationMembers.userId, schema.faceTemplates.userId),
      eq(schema.organizationMembers.organizationId, schema.faceTemplates.facilityId),
    ))
    .where(and(eq(schema.faceTemplates.userId, userId), eq(schema.faceConsents.policyVersion, POLICY_VERSION), isNull(schema.faceTemplates.revokedAt), isNull(schema.faceConsents.revokedAt), gt(schema.faceConsents.at, cutoff)));
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
    const templates = await tx.select().from(schema.faceTemplates)
      .where(and(eq(schema.faceTemplates.facilityId, facilityId), isNull(schema.faceTemplates.revokedAt)));
    const consents = await tx.select({ userId: schema.faceConsents.userId })
      .from(schema.faceConsents)
      .where(and(eq(schema.faceConsents.facilityId, facilityId), isNull(schema.faceConsents.revokedAt)));
    const now = new Date();
    for (const row of templates) {
      await tx.delete(schema.faceTemplates).where(eq(schema.faceTemplates.id, row.id));
      await tx.insert(schema.faceTemplateTombstones).values({ id: crypto.randomUUID(), userId: row.userId, facilityId, version: row.version, revokedAt: now, reason });
    }
    await tx.update(schema.faceConsents).set({ revokedAt: now })
      .where(and(eq(schema.faceConsents.facilityId, facilityId), isNull(schema.faceConsents.revokedAt)));
    return new Set([...templates, ...consents].map((row) => row.userId)).size;
  });
}
