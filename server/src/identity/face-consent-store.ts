/**
 * 顔認証の同意記録 (face_consents) の正本操作。
 *
 * Cernere が顔について持つのは「同意したか」「撤回したか」だけで、テンプレートと
 * 写真は持たない (spec/feature/face-consent-and-revocation.md)。撤回・所属離脱・
 * 卒業・アカウント削除・365 日再同意なし・職員無効化では、施設 kiosk 側の登録を
 * 消させるために失効指示を 1 行積む (face-revocation-store)。
 *
 * 生体情報 (テンプレート・写真・埋め込み) はこのモジュールを通らない。
 */

import crypto from "node:crypto";
import { and, eq, isNull, lt } from "drizzle-orm";
import { AppError } from "../error.js";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import {
  CURRENT_POLICY_VERSION,
  LOCAL_POLICY_VERSION,
  PHOTO_POLICY_VERSION,
  RECONSENT_DAYS,
  TEMPLATE_POLICY_VERSION,
  isAcceptableNewConsentVersion,
  requireFacilityMembership,
} from "./face-consent-guard.js";
import { lockFaceConsentMutation, lockFaceConsentMutations } from "./face-consent-lock.js";
import { appendFaceRevocations, type FaceRevocationReason } from "./face-revocation-store.js";

/**
 * 同意文面は版ごとに保持する。kiosk (Ostiarius) と GLab の同意画面は
 * GET /api/identity/face-consent/policy から版と文面を取得して表示する契約。
 *
 * 旧版は既存同意行の説明のために残すだけで、新規同意には使えない
 * (`requiredFor` が空の版 = もう提示しない版)。
 */
export const faceConsentPolicies = [
  {
    version: TEMPLATE_POLICY_VERSION,
    requiredFor: [] as string[],
    deprecated: true,
    text: "顔認証では顔写真を保存せず、暗号化した特徴テンプレートのみを在籍中かつ同意から365日まで保持します。プロフィールからいつでも撤回できます。",
  },
  {
    version: PHOTO_POLICY_VERSION,
    requiredFor: [] as string[],
    deprecated: true,
    text: "顔認証のために、プロフィール顔写真を1枚だけ暗号化して保存します。写真は職員の名簿・出席確認画面と本人のプロフィールでのみ表示し、受付端末 (kiosk) には表示しません。写真から作った特徴テンプレートは、職員が本人確認して承認するまで出席の照合には使いません。写真と特徴テンプレートは在籍中かつ同意から365日まで保持し、プロフィールからの削除操作または同意の撤回で、写真とテンプレートを同時に削除します。",
  },
  {
    version: LOCAL_POLICY_VERSION,
    requiredFor: ["face-template", "face-photo"] as string[],
    deprecated: false,
    text: "顔認証のために、顔の特徴テンプレートとプロフィール顔写真1枚を暗号化して保存します。保存先は施設の受付端末 (kiosk) のみで、施設外 (クラウド) へは出しません。表示は施設内の職員画面 (名簿・出席確認) と本人に限り、kiosk の待機画面には表示しません。保持は在籍中かつ同意から365日までで、撤回・卒業・所属の終了・アカウント削除のいずれかで施設の端末から削除します。撤回はこのプロフィールまたは施設の受付で行えます。",
  },
] as const;

export const faceConsentPolicy = {
  version: CURRENT_POLICY_VERSION,
  text: faceConsentPolicies.find((policy) => policy.version === CURRENT_POLICY_VERSION)?.text ?? "",
  policies: faceConsentPolicies,
};

/**
 * 本人の同意を記録する。現行版以外 (= 旧版) は受理しない: 旧版は「Cernere に
 * 保存する」前提の文面なので、施設ローカル保存の根拠にならない。
 */
export async function createFaceConsent(userId: string, policyVersion: string, facilityId: string) {
  if (!isAcceptableNewConsentVersion(policyVersion)) {
    throw AppError.conflict("current_policy_consent_required");
  }
  await requireFacilityMembership(userId, facilityId);
  const at = new Date();
  const consentId = await db.transaction(async (tx) => {
    await lockFaceConsentMutation(userId, tx);
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
      // 同じ版の再同意は日付だけ更新する (365 日の起点を延ばす)。
      await tx.update(schema.faceConsents).set({ at })
        .where(eq(schema.faceConsents.id, current.id));
      return current.id;
    }
    // 旧版からの移行。旧同意を撤回済みにするだけで、失効指示は積まない:
    // 本人が新しい版に同意した直後に kiosk の登録を消させる必要はない。
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

export interface FaceConsentRow {
  userId: string;
  consentId: string;
  policyVersion: string;
  at: string;
  revokedAt: string | null;
}

function toConsentRow(row: {
  userId: string;
  id: string;
  policyVersion: string;
  at: Date;
  revokedAt: Date | null;
}): FaceConsentRow {
  return {
    userId: row.userId,
    consentId: row.id,
    policyVersion: row.policyVersion,
    at: row.at.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

/**
 * 施設の同意記録を全量返す。Ostiarius は写しとして保持し、Cernere 不通でも
 * 「同意が有効か / 365 日以内か / 現行版か」を自前判定する。
 */
export async function listFaceConsents(facilityId: string): Promise<FaceConsentRow[]> {
  await purgeExpiredFaceConsents({ facilityId });
  const rows = await db.select({
    userId: schema.faceConsents.userId,
    id: schema.faceConsents.id,
    policyVersion: schema.faceConsents.policyVersion,
    at: schema.faceConsents.at,
    revokedAt: schema.faceConsents.revokedAt,
  }).from(schema.faceConsents)
    .where(eq(schema.faceConsents.facilityId, facilityId))
    .orderBy(schema.faceConsents.at);
  return rows.map(toConsentRow);
}

/** 本人のプロフィール表示用。自分の同意だけを返す。 */
export async function listOwnFaceConsents(userId: string) {
  await purgeExpiredFaceConsents({ userId });
  const rows = await db.select({
    facilityId: schema.faceConsents.facilityId,
    id: schema.faceConsents.id,
    policyVersion: schema.faceConsents.policyVersion,
    at: schema.faceConsents.at,
    revokedAt: schema.faceConsents.revokedAt,
  }).from(schema.faceConsents)
    .where(and(eq(schema.faceConsents.userId, userId), isNull(schema.faceConsents.revokedAt)));
  return {
    items: rows.map((row) => ({
      facilityId: row.facilityId,
      consentId: row.id,
      policyVersion: row.policyVersion,
      at: row.at.toISOString(),
      reconsentRequired: row.policyVersion !== CURRENT_POLICY_VERSION,
    })),
  };
}

/**
 * 同意を撤回し、失効指示を積む。
 *
 * facilityId 省略時 (アカウント削除) は全施設が対象で、施設ごとに 1 行積む。
 * 既に撤回済みでも失効指示は積む: Cernere 側の同意状態と、kiosk に残っている
 * かもしれない登録は別物で、「消せ」の指示は届かせる必要がある。
 */
export async function revokeFaceConsents(
  userId: string,
  facilityId: string | undefined,
  reason: FaceRevocationReason,
): Promise<{ ok: true; revoked: number; facilities: string[] }> {
  return db.transaction(async (tx) => {
    await lockFaceConsentMutation(userId, tx);
    const scope = facilityId
      ? and(eq(schema.faceConsents.userId, userId), eq(schema.faceConsents.facilityId, facilityId))
      : eq(schema.faceConsents.userId, userId);
    const rows = await tx.select({
      id: schema.faceConsents.id,
      facilityId: schema.faceConsents.facilityId,
      revokedAt: schema.faceConsents.revokedAt,
    }).from(schema.faceConsents).where(scope);
    const now = new Date();
    const active = rows.filter((row) => row.revokedAt === null);
    if (active.length > 0) {
      await tx.update(schema.faceConsents).set({ revokedAt: now })
        .where(and(scope, isNull(schema.faceConsents.revokedAt)));
    }
    // 同意行が 1 件も無くても、facilityId が分かっているなら指示は積む
    // (kiosk 側にだけ登録が残っている取りこぼしを残さない)。
    const facilities = facilityId
      ? [facilityId]
      : [...new Set(rows.map((row) => row.facilityId))];
    await appendFaceRevocations(
      tx,
      facilities.map((id) => ({ userId, facilityId: id })),
      reason,
      now,
    );
    return { ok: true as const, revoked: active.length, facilities };
  });
}

/** 施設の削除・閉鎖で、在籍者全員分の同意を撤回し失効指示を積む。 */
export async function revokeFacilityFaceConsents(
  facilityId: string,
  reason: FaceRevocationReason,
): Promise<number> {
  return db.transaction(async (tx) => {
    const consents = await tx.select({
      id: schema.faceConsents.id,
      userId: schema.faceConsents.userId,
    }).from(schema.faceConsents)
      .where(eq(schema.faceConsents.facilityId, facilityId));
    const userIds = [...new Set(consents.map((consent) => consent.userId))];
    await lockFaceConsentMutations(userIds, tx);
    const now = new Date();
    await tx.update(schema.faceConsents).set({ revokedAt: now })
      .where(and(eq(schema.faceConsents.facilityId, facilityId), isNull(schema.faceConsents.revokedAt)));
    await appendFaceRevocations(tx, userIds.map((userId) => ({ userId, facilityId })), reason, now);
    return userIds.length;
  });
}

/**
 * 365 日再同意が無い同意を撤回し、失効指示 consent_expired を積む。
 * 起動時と、同意・失効指示の配布時に呼ぶ。
 */
export async function purgeExpiredFaceConsents(
  scope: { userId?: string; facilityId?: string } = {},
): Promise<number> {
  const cutoff = new Date(Date.now() - RECONSENT_DAYS * 86400000);
  const scopeCondition = scope.userId
    ? eq(schema.faceConsents.userId, scope.userId)
    : scope.facilityId
      ? eq(schema.faceConsents.facilityId, scope.facilityId)
      : undefined;
  return db.transaction(async (tx) => {
    const expired = await tx.select({
      id: schema.faceConsents.id,
      userId: schema.faceConsents.userId,
      facilityId: schema.faceConsents.facilityId,
    }).from(schema.faceConsents)
      .where(and(isNull(schema.faceConsents.revokedAt), lt(schema.faceConsents.at, cutoff), scopeCondition));
    if (expired.length === 0) return 0;
    const now = new Date();
    await tx.update(schema.faceConsents).set({ revokedAt: now })
      .where(and(isNull(schema.faceConsents.revokedAt), lt(schema.faceConsents.at, cutoff), scopeCondition));
    await appendFaceRevocations(
      tx,
      expired.map((row) => ({ userId: row.userId, facilityId: row.facilityId })),
      "consent_expired",
      now,
    );
    return expired.length;
  });
}
