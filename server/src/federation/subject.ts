/**
 * サービス境界の利用者番号の解決 (spec/plan/2026-10-15-account-federation-design.md §3)。
 *
 * サービスへ利用者を渡す全ての口 (authCode / exchange・project token・OIDC・project user data・
 * 同意記録・profile.get・relay) はここを通す。Cernere 内部 (パスキー・セッション・端末管理) は
 * 各アカウントの user id のまま扱う。
 *
 * 番号の解決は冪等: 連携番号は founder の user id で、founder が他の連携に入ることは
 * decideFederationJoin が拒否するため、resolve(resolve(x).subject) は resolve(x) と同じ番号になる。
 */

import { and, eq, ne } from "drizzle-orm";

import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { ACCOUNT_LOCKED, getAccessStatus, requireActiveUser, type AccessStatus } from "../auth/user-access.js";
import { pickServiceSubject, type FederationMembership, type ServiceSubject } from "./policy.js";

type Reader = Pick<typeof db, "select">;

export const FEDERATION_FOUNDER_DETACHED = "federation_founder_detached";

/** アカウントの連携の状況 (連携していなければ null)。 */
export async function findMembership(userId: string, reader: Reader = db): Promise<FederationMembership | null> {
  const row = (await reader.select({
    federationId: schema.accountFederations.id,
    subjectId: schema.accountFederations.subjectId,
    primaryUserId: schema.accountFederations.primaryUserId,
  }).from(schema.accountFederationMembers)
    .innerJoin(schema.accountFederations, eq(schema.accountFederationMembers.federationId, schema.accountFederations.id))
    .where(eq(schema.accountFederationMembers.userId, userId)).limit(1))[0];
  return row ?? null;
}

/** id がどこかの連携の番号で、その連携に属していないか (外れた founder)。 */
export async function ownsForeignSubject(userId: string, reader: Reader = db, exceptFederationId?: string): Promise<boolean> {
  const where = exceptFederationId
    ? and(eq(schema.accountFederations.subjectId, userId), ne(schema.accountFederations.id, exceptFederationId))
    : eq(schema.accountFederations.subjectId, userId);
  const row = (await reader.select({ id: schema.accountFederations.id }).from(schema.accountFederations)
    .where(where).limit(1))[0];
  return row !== undefined;
}

/** アカウントの user id → サービスへ渡す番号と主。 */
export async function resolveServiceSubject(userId: string, reader: Reader = db): Promise<ServiceSubject> {
  const membership = await findMembership(userId, reader);
  const foreign = membership ? false : await ownsForeignSubject(userId, reader);
  return pickServiceSubject(userId, membership, foreign);
}

/** サービスへ渡す番号だけが要るとき。 */
export async function serviceSubjectId(userId: string, reader: Reader = db): Promise<string> {
  return (await resolveServiceSubject(userId, reader)).subject;
}

/**
 * サービスから受け取った利用者番号 → 名前・プロフィールの基準にするアカウント (主)。
 * 連携の番号なら主、そうでなければ番号そのもの (未連携のアカウントの user id)。
 */
export async function primaryUserIdForSubject(subject: string, reader: Reader = db): Promise<string> {
  const row = (await reader.select({ primaryUserId: schema.accountFederations.primaryUserId })
    .from(schema.accountFederations).where(eq(schema.accountFederations.subjectId, subject)).limit(1))[0];
  return row?.primaryUserId ?? subject;
}

/**
 * 同じ番号でサービスを使うアカウント全て (relay・通知の宛先)。
 * 連携の番号でもアカウントの user id でも受け、連携していなければその id だけを返す。
 */
export async function accountIdsForSubjectOrUser(id: string, reader: Reader = db): Promise<string[]> {
  const membership = await findMembership(id, reader);
  const federationId = membership?.federationId
    ?? (await reader.select({ id: schema.accountFederations.id }).from(schema.accountFederations)
      .where(eq(schema.accountFederations.subjectId, id)).limit(1))[0]?.id;
  if (!federationId) return [id];
  const rows = await reader.select({ userId: schema.accountFederationMembers.userId })
    .from(schema.accountFederationMembers).where(eq(schema.accountFederationMembers.federationId, federationId));
  return rows.map((row) => row.userId);
}

/**
 * サービスへ入れるかの判定 (068 許可制 × 連携、§3)。
 *   - そのアカウント自身が locked ならそのアカウントでは入れない
 *   - 入れるかは主の access_status で決める (主が locked / pending なら連携全体が入れない)
 *   - 連携番号を残して外れた founder は入れない (連携のデータが見えてしまうため)
 */
export async function requireServiceAccess(userId: string, reader: Reader = db): Promise<ServiceSubject> {
  if (await getAccessStatus(userId, reader) === "locked") {
    throw AppError.withCode(403, ACCOUNT_LOCKED, "This account is locked.");
  }
  const resolved = await resolveServiceSubject(userId, reader);
  if (resolved.detachedFounder) {
    throw AppError.withCode(403, FEDERATION_FOUNDER_DETACHED,
      "This account left its federation while the federation still uses its number. Rejoin or close the federation.");
  }
  await requireActiveUser(resolved.primaryUserId, reader);
  return resolved;
}

/**
 * Cernere 内の操作で使う許可状態。自分が locked ならそのまま locked、連携していれば主の状態に従う
 * (引き継ぎで作った端末のアカウントは pending のまま作られるが、主が active なら同じ利用者として扱う)。
 */
export async function effectiveAccessStatus(userId: string, reader: Reader = db): Promise<AccessStatus> {
  const own = await getAccessStatus(userId, reader);
  if (own === "locked") return own;
  const membership = await findMembership(userId, reader);
  if (!membership || membership.primaryUserId === userId) return own;
  return getAccessStatus(membership.primaryUserId, reader);
}

/** サービスへ渡す名前・メール・role (主のもの)。 */
export interface ServiceIdentity {
  subject: string;
  primaryUserId: string;
  displayName: string;
  email: string | null;
  role: string;
}

export async function loadServiceIdentity(userId: string, reader: Reader = db): Promise<ServiceIdentity | null> {
  const resolved = await resolveServiceSubject(userId, reader);
  const primary = (await reader.select({
    displayName: schema.users.displayName,
    email: schema.users.email,
    role: schema.users.role,
  }).from(schema.users).where(eq(schema.users.id, resolved.primaryUserId)).limit(1))[0];
  if (!primary) return null;
  return {
    subject: resolved.subject,
    primaryUserId: resolved.primaryUserId,
    displayName: primary.displayName ?? "",
    email: primary.email,
    role: primary.role ?? "general",
  };
}
