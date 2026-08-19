/**
 * 顔データ共通の前提チェック (施設所属と、経路が要求する版の有効な同意)。
 *
 * 同意版は経路ごとに分ける:
 *   - テンプレート経路 (PUT face-template / export / status)
 *       -> face-template-v1 以上。写真版の同意はテンプレートも包含する。
 *   - 写真経路 (POST face-photo)
 *       -> face-photo-v1 のみ。写真を保存すると書いていない旧版では保存しない。
 *
 * 版を上げても既存同意が一斉に旧版化して出席照合が止まらないよう、
 * 「新しい版は古い版を包含する」という関係をここ 1 箇所で表現する。
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import type { FaceDbClient } from "./face-db-client.js";

/** 顔テンプレートのみを対象にした初版。写真は保存しないと明記している。 */
export const TEMPLATE_POLICY_VERSION = "face-template-v1";
/** 写真の保存・表示範囲・削除を明記した版。テンプレート経路も包含する。 */
export const PHOTO_POLICY_VERSION = "face-photo-v1";

/** 古い順。後ろの版は前の版を包含する。 */
export const FACE_POLICY_VERSIONS = [TEMPLATE_POLICY_VERSION, PHOTO_POLICY_VERSION] as const;
export type FacePolicyVersion = typeof FACE_POLICY_VERSIONS[number];

/** 取得可能な最新版 (同意画面が既定で提示する版)。 */
export const CURRENT_POLICY_VERSION: FacePolicyVersion = PHOTO_POLICY_VERSION;

export const RECONSENT_DAYS = 365;
export const TOMBSTONE_DAYS = 30;

/** その版以上で有効とみなす版の一覧。 */
export function acceptedVersionsFrom(minimum: FacePolicyVersion): FacePolicyVersion[] {
  return FACE_POLICY_VERSIONS.slice(FACE_POLICY_VERSIONS.indexOf(minimum));
}

/** テンプレート経路が受け入れる版 (template 版 or それ以上)。 */
export const TEMPLATE_ACCEPTED_VERSIONS = acceptedVersionsFrom(TEMPLATE_POLICY_VERSION);
/** 写真経路が受け入れる版 (photo 版のみ)。 */
export const PHOTO_ACCEPTED_VERSIONS = acceptedVersionsFrom(PHOTO_POLICY_VERSION);

export function isKnownPolicyVersion(version: string): version is FacePolicyVersion {
  return (FACE_POLICY_VERSIONS as readonly string[]).includes(version);
}

export async function requireFacilityMembership(
  userId: string,
  facilityId: string,
  client: FaceDbClient = db,
): Promise<void> {
  const membership = await client.select({ userId: schema.organizationMembers.userId })
    .from(schema.organizationMembers)
    .where(and(
      eq(schema.organizationMembers.userId, userId),
      eq(schema.organizationMembers.organizationId, facilityId),
    ))
    .limit(1);
  if (membership.length === 0) throw AppError.forbidden("User is not a member of this facility");
}

/** 顔テンプレートの登録・承認・却下を行える施設職員だけを通す。 */
export async function requireFaceReviewer(
  userId: string,
  facilityId: string,
  client: FaceDbClient = db,
): Promise<void> {
  const membership = await client.select({ role: schema.organizationMembers.role })
    .from(schema.organizationMembers)
    .where(and(
      eq(schema.organizationMembers.userId, userId),
      eq(schema.organizationMembers.organizationId, facilityId),
    ))
    .limit(1);
  if (!["owner", "admin", "maintainer"].includes(membership[0]?.role ?? "")) {
    throw AppError.forbidden("Face template reviewer role is required");
  }
}

export function isConsentFresh(at: Date): boolean {
  return at >= new Date(Date.now() - RECONSENT_DAYS * 86400000);
}

/**
 * 経路が要求する版の有効な同意を取り出す。要求版に満たない / 撤回済み /
 * 365 日再同意なしは 409 consent_required。
 */
export async function requireActiveConsent(
  userId: string,
  facilityId: string,
  options: { versions?: readonly string[]; client?: FaceDbClient } = {},
): Promise<{ id: string; at: Date }> {
  const versions = options.versions ?? TEMPLATE_ACCEPTED_VERSIONS;
  const client = options.client ?? db;
  const rows = await client.select({ id: schema.faceConsents.id, at: schema.faceConsents.at })
    .from(schema.faceConsents)
    .where(and(
      eq(schema.faceConsents.userId, userId),
      eq(schema.faceConsents.facilityId, facilityId),
      inArray(schema.faceConsents.policyVersion, [...versions]),
      isNull(schema.faceConsents.revokedAt),
    ))
    .limit(1);
  const consent = rows[0];
  if (!consent || !isConsentFresh(consent.at)) throw AppError.conflict("consent_required");
  return consent;
}
