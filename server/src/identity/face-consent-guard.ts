/**
 * 顔データ同意の前提チェック (施設所属・職員ロール・同意版)。
 *
 * 2026-09-12 の方針変更で、顔テンプレートと顔写真の正本は施設の kiosk ホスト
 * (Ostiarius) に移った。Cernere が持つのは同意記録と失効指示だけなので、ここは
 * 「どの版の同意が現行か」「誰が撤回を指示できるか」だけを判定する。
 *
 * 版は古い順に並べ、新しい版は古い版を包含する。過去の版 (face-template-v1 /
 * face-photo-v1) は **既存同意行を読むためだけに**残す。現行版は face-local-v1 で、
 * 「保存先は施設の kiosk 端末のみ」を明記している。旧版の同意しか無い生徒には
 * 再同意を求める (照合可否は Ostiarius が policyVersion を見て判定する)。
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import type { FaceDbClient } from "./face-db-client.js";

/** 顔テンプレートのみを対象にした初版 (Cernere 正本時代)。現行ではない。 */
export const TEMPLATE_POLICY_VERSION = "face-template-v1";
/** プロフィール顔写真の Cernere 保存を含む版 (Cernere 正本時代)。現行ではない。 */
export const PHOTO_POLICY_VERSION = "face-photo-v1";
/** 保存先を施設 kiosk 端末に限定した版。現行。 */
export const LOCAL_POLICY_VERSION = "face-local-v1";

/** 古い順。後ろの版は前の版を包含する。 */
export const FACE_POLICY_VERSIONS = [
  TEMPLATE_POLICY_VERSION,
  PHOTO_POLICY_VERSION,
  LOCAL_POLICY_VERSION,
] as const;
export type FacePolicyVersion = typeof FACE_POLICY_VERSIONS[number];

/** 同意画面が提示する版。新規・再同意はこの版で記録する。 */
export const CURRENT_POLICY_VERSION: FacePolicyVersion = LOCAL_POLICY_VERSION;

export const RECONSENT_DAYS = 365;

/** その版以上で有効とみなす版の一覧。 */
export function acceptedVersionsFrom(minimum: FacePolicyVersion): FacePolicyVersion[] {
  return FACE_POLICY_VERSIONS.slice(FACE_POLICY_VERSIONS.indexOf(minimum));
}

/**
 * 施設ローカル保存の根拠になる版 (= 現行版のみ)。旧版は「Cernere に保存する」
 * 前提の文面なので、kiosk ローカル保存の根拠にはならない。
 */
export const LOCAL_ACCEPTED_VERSIONS = acceptedVersionsFrom(LOCAL_POLICY_VERSION);

export function isKnownPolicyVersion(version: string): version is FacePolicyVersion {
  return (FACE_POLICY_VERSIONS as readonly string[]).includes(version);
}

/** 新規・再同意として受理する版。過去の版で新しい同意を打たせない。 */
export function isAcceptableNewConsentVersion(version: string): version is FacePolicyVersion {
  return (LOCAL_ACCEPTED_VERSIONS as readonly string[]).includes(version);
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

/** 顔認証登録の撤回・無効化を指示できる施設職員だけを通す。 */
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
