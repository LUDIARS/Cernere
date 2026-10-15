/**
 * 連携 (account_federations) の読み書き (spec/plan/2026-10-15-account-federation-design.md §2 / §4)。
 *
 * 判定は policy.ts の純粋関数に任せ、ここでは行のロック・書き込み・監査・通知を 1 トランザクションで行う。
 * 連携の行は federation 行を FOR UPDATE で取って直列化する (加入・主の切替・取り外しの競合を防ぐ)。
 */

import crypto from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";

import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { recordSecurityEvent, type SecurityEventKind } from "../notify/security-events.js";
import {
  decideFederationJoin,
  decideFederationRemoval,
  decideSetPrimary,
  type FederationJoinVia,
  type JoinRefusal,
} from "./policy.js";
import { findMembership, ownsForeignSubject } from "./subject.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type EventAction = "create" | "join" | "leave" | "remove" | "set_primary";

export const FEDERATION_JOIN_REFUSED = "federation_join_refused";
export const FEDERATION_REVISION_CONFLICT = "federation_revision_conflict";

const JOIN_MESSAGES: Record<JoinRefusal, string> = {
  self: "An account cannot federate with itself",
  joiner_already_federated: "This account is already federated with other accounts",
  joiner_owns_subject: "This account's number is still used by a federation it left",
  federation_full: "A federation can hold up to 10 accounts",
};

async function lockFederation(tx: Tx, federationId: string) {
  const row = (await tx.select().from(schema.accountFederations)
    .where(eq(schema.accountFederations.id, federationId)).for("update"))[0];
  if (!row) throw AppError.conflict("The federation changed; reload and try again");
  return row;
}

async function memberIds(tx: Pick<Tx, "select">, federationId: string): Promise<string[]> {
  const rows = await tx.select({ userId: schema.accountFederationMembers.userId })
    .from(schema.accountFederationMembers)
    .where(eq(schema.accountFederationMembers.federationId, federationId))
    .orderBy(asc(schema.accountFederationMembers.joinedAt), asc(schema.accountFederationMembers.userId));
  return rows.map((row) => row.userId);
}

async function audit(tx: Tx, federationId: string, action: EventAction, actorUserId: string | null, targetUserId: string | null) {
  await tx.insert(schema.accountFederationEvents).values({
    id: crypto.randomUUID(), federationId, action, actorUserId, targetUserId,
  });
}

/** 連携の全アカウントの他セッションと通知先へ知らせる (§4.1-6)。 */
async function notifyMembers(tx: Tx, userIds: readonly string[], kind: SecurityEventKind, device?: string) {
  for (const userId of new Set(userIds)) {
    await recordSecurityEvent(tx, userId, kind, device ? { device } : {});
  }
}

export interface JoinResult {
  federationId: string;
  subjectId: string;
  primaryUserId: string;
}

/**
 * joiner を approver の連携へ加える。approver が連携していなければ approver を founder として連携を作る。
 * 呼び出し側のトランザクション内で呼ぶ (新しい端末の signup と同じトランザクションにするため)。
 */
export async function joinFederation(tx: Tx, input: {
  approverUserId: string;
  joinerUserId: string;
  via: Exclude<FederationJoinVia, "founder">;
  device?: string;
}): Promise<JoinResult> {
  // approver と joiner の users 行をロックし、同時の加入・離脱と直列化する。
  await tx.select({ id: schema.users.id }).from(schema.users)
    .where(inArray(schema.users.id, [input.approverUserId, input.joinerUserId])).for("update");
  const approverMembership = await findMembership(input.approverUserId, tx);
  if (approverMembership) await lockFederation(tx, approverMembership.federationId);
  const members = approverMembership ? await memberIds(tx, approverMembership.federationId) : [];
  const decision = decideFederationJoin({
    approverUserId: input.approverUserId,
    joinerUserId: input.joinerUserId,
    approverMembership,
    memberCount: members.length,
    joinerFederated: (await findMembership(input.joinerUserId, tx)) !== null,
    joinerOwnsSubject: await ownsForeignSubject(input.joinerUserId, tx),
  });
  if (!decision.ok) throw AppError.withCode(409, FEDERATION_JOIN_REFUSED, JOIN_MESSAGES[decision.reason]);

  let federationId = approverMembership?.federationId;
  let primaryUserId = approverMembership?.primaryUserId ?? input.approverUserId;
  if (decision.createFederation) {
    // 外れた founder が自分の番号の連携を作り直すことは無い (ownsForeignSubject で approver 側も確認する)。
    if (await ownsForeignSubject(input.approverUserId, tx)) {
      throw AppError.withCode(409, FEDERATION_JOIN_REFUSED, JOIN_MESSAGES.joiner_owns_subject);
    }
    federationId = crypto.randomUUID();
    primaryUserId = input.approverUserId;
    await tx.insert(schema.accountFederations).values({
      id: federationId, subjectId: decision.subjectId, primaryUserId, revision: 0,
    });
    await tx.insert(schema.accountFederationMembers).values({
      federationId, userId: input.approverUserId, joinedVia: "founder",
    });
    await audit(tx, federationId, "create", input.approverUserId, input.approverUserId);
  }
  const id = federationId!;
  await tx.insert(schema.accountFederationMembers).values({ federationId: id, userId: input.joinerUserId, joinedVia: input.via });
  await tx.update(schema.accountFederations)
    .set({ revision: (await lockFederation(tx, id)).revision + 1 })
    .where(eq(schema.accountFederations.id, id));
  await audit(tx, id, "join", input.approverUserId, input.joinerUserId);
  await notifyMembers(tx, [...members, input.approverUserId, input.joinerUserId], "federation.joined", input.device);
  return { federationId: id, subjectId: decision.subjectId, primaryUserId };
}

export interface FederationMemberView {
  userId: string;
  displayName: string;
  joinedVia: string;
  joinedAt: string;
  isPrimary: boolean;
  isSelf: boolean;
  isFounder: boolean;
  passkeyCount: number;
}

export interface FederationView {
  federationId: string | null;
  /** 連携していなければ自分の id */
  subjectId: string;
  primaryUserId: string;
  revision: number;
  members: FederationMemberView[];
}

/** 設定画面用: 自分の連携の一覧 (連携していなければ自分だけ)。 */
export async function describeFederation(userId: string): Promise<FederationView> {
  const membership = await findMembership(userId);
  if (!membership) {
    return { federationId: null, subjectId: userId, primaryUserId: userId, revision: 0, members: [] };
  }
  const federation = (await db.select().from(schema.accountFederations)
    .where(eq(schema.accountFederations.id, membership.federationId)).limit(1))[0];
  const rows = await db.select({
    userId: schema.accountFederationMembers.userId,
    joinedVia: schema.accountFederationMembers.joinedVia,
    joinedAt: schema.accountFederationMembers.joinedAt,
    displayName: schema.users.displayName,
  }).from(schema.accountFederationMembers)
    .innerJoin(schema.users, eq(schema.accountFederationMembers.userId, schema.users.id))
    .where(eq(schema.accountFederationMembers.federationId, membership.federationId))
    .orderBy(asc(schema.accountFederationMembers.joinedAt));
  const passkeys = rows.length === 0 ? [] : await db.select({ userId: schema.passkeys.userId, revokedAt: schema.passkeys.revokedAt })
    .from(schema.passkeys).where(inArray(schema.passkeys.userId, rows.map((row) => row.userId)));
  return {
    federationId: membership.federationId,
    subjectId: membership.subjectId,
    primaryUserId: membership.primaryUserId,
    revision: federation?.revision ?? 0,
    members: rows.map((row) => ({
      userId: row.userId,
      displayName: row.displayName,
      joinedVia: row.joinedVia,
      joinedAt: row.joinedAt.toISOString(),
      isPrimary: row.userId === membership.primaryUserId,
      isSelf: row.userId === userId,
      isFounder: row.userId === membership.subjectId,
      passkeyCount: passkeys.filter((p) => p.userId === row.userId && p.revokedAt === null).length,
    })),
  };
}

const PRIMARY_MESSAGES = {
  not_primary: "Only the current primary account can choose the primary",
  not_member: "The account is not part of this federation",
  revision_conflict: "The federation changed; reload and try again",
  unchanged: "That account is already the primary",
} as const;

/** 主を切り替える (現在の主のパスキーで承認済み、expected revision)。subject は変わらない。 */
export async function setFederationPrimary(actorUserId: string, candidateUserId: string, expectedRevision: number): Promise<FederationView> {
  await db.transaction(async (tx) => {
    const membership = await findMembership(actorUserId, tx);
    if (!membership) throw AppError.notFound("This account is not federated");
    const federation = await lockFederation(tx, membership.federationId);
    const members = await memberIds(tx, federation.id);
    const decision = decideSetPrimary({
      actorUserId, primaryUserId: federation.primaryUserId, candidateUserId,
      memberUserIds: members, revision: federation.revision, expectedRevision,
    });
    if (!decision.ok) {
      const status = decision.reason === "revision_conflict" ? 409 : decision.reason === "not_primary" ? 403 : 400;
      throw AppError.withCode(status, decision.reason === "revision_conflict" ? FEDERATION_REVISION_CONFLICT : `federation_${decision.reason}`,
        PRIMARY_MESSAGES[decision.reason]);
    }
    await tx.update(schema.accountFederations)
      .set({ primaryUserId: candidateUserId, revision: decision.nextRevision })
      .where(eq(schema.accountFederations.id, federation.id));
    await audit(tx, federation.id, "set_primary", actorUserId, candidateUserId);
    await notifyMembers(tx, members, "federation.primary_changed");
  });
  return describeFederation(actorUserId);
}

const REMOVAL_MESSAGES = {
  not_member: "The account is not part of this federation",
  not_allowed: "Only the primary account can remove another account",
  revision_conflict: "The federation changed; reload and try again",
} as const;

async function applyRemoval(tx: Tx, federationId: string, target: string, closes: boolean, nextPrimary: string | null,
  nextRevision: number, members: readonly string[]): Promise<void> {
  if (closes) {
    // 連携を閉じる: 残りのアカウントは自分の id に戻る。監査 (account_federation_events) は残る。
    await tx.delete(schema.accountFederationMembers).where(eq(schema.accountFederationMembers.federationId, federationId));
    await tx.delete(schema.accountFederations).where(eq(schema.accountFederations.id, federationId));
  } else {
    await tx.delete(schema.accountFederationMembers).where(eq(schema.accountFederationMembers.userId, target));
    await tx.update(schema.accountFederations)
      .set({ revision: nextRevision, ...(nextPrimary ? { primaryUserId: nextPrimary } : {}) })
      .where(eq(schema.accountFederations.id, federationId));
  }
  await notifyMembers(tx, members, "federation.left");
}

/** 連携から外す (主の承認 / 本人の離脱、どちらもパスキーで承認済み)。最後の 1 つになったら閉じる。 */
export async function removeFederationMember(actorUserId: string, targetUserId: string, expectedRevision: number): Promise<FederationView> {
  await db.transaction(async (tx) => {
    const membership = await findMembership(actorUserId, tx);
    if (!membership) throw AppError.notFound("This account is not federated");
    const federation = await lockFederation(tx, membership.federationId);
    const members = await memberIds(tx, federation.id);
    const decision = decideFederationRemoval({
      actorUserId, targetUserId, primaryUserId: federation.primaryUserId,
      memberUserIds: members, revision: federation.revision, expectedRevision,
    });
    if (!decision.ok) {
      const status = decision.reason === "revision_conflict" ? 409 : decision.reason === "not_allowed" ? 403 : 400;
      throw AppError.withCode(status, decision.reason === "revision_conflict" ? FEDERATION_REVISION_CONFLICT : `federation_${decision.reason}`,
        REMOVAL_MESSAGES[decision.reason]);
    }
    await audit(tx, federation.id, decision.action, actorUserId, targetUserId);
    await applyRemoval(tx, federation.id, targetUserId, decision.closes, decision.nextPrimaryUserId, decision.nextRevision, members);
  });
  return describeFederation(actorUserId);
}

/**
 * アカウント削除の前に連携から外す (本人の離脱と同じ扱い。削除そのものが本人確認済みの操作)。
 * primary_user_id は users を参照するので、主のまま消すと FK で削除が止まる。
 */
export async function detachForAccountDeletion(tx: Tx, userId: string): Promise<void> {
  const membership = await findMembership(userId, tx);
  if (!membership) return;
  const federation = await lockFederation(tx, membership.federationId);
  const members = await memberIds(tx, federation.id);
  const decision = decideFederationRemoval({
    actorUserId: userId, targetUserId: userId, primaryUserId: federation.primaryUserId,
    memberUserIds: members, revision: federation.revision, expectedRevision: federation.revision,
  });
  if (!decision.ok) return;
  await audit(tx, federation.id, "leave", userId, userId);
  await applyRemoval(tx, federation.id, userId, decision.closes, decision.nextPrimaryUserId, decision.nextRevision,
    members.filter((id) => id !== userId));
}
