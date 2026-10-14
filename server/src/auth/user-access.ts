/**
 * ユーザー登録の許可制 (spec/plan/2026-10-14-registration-approval-design-astra.md 案 A)。
 *
 *   pending  許可待ち。Cernere 内の本人用操作だけができ、他人のデータとサービスへのログインには進めない
 *   active   許可済み。既存の組織ロール・共有設定・サービス権限の範囲で使える
 *   locked   停止。全経路で拒否する (assertUserSessionCurrent)
 *
 * 状態の変更は active な system admin だけが行い、対象行のロックと expected revision で直列化する。
 * 状態・auth_epoch・監査・通知を同じトランザクションで書く。未知の状態値は拒否側に倒す。
 */

import crypto from "node:crypto";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { recordSecurityEvent, type SecurityEventKind } from "../notify/security-events.js";

export type AccessStatus = "pending" | "active" | "locked";

export function parseAccessStatus(value: unknown): AccessStatus {
  return value === "pending" || value === "active" ? value : "locked";
}

type Reader = Pick<typeof db, "select">;
type Database = Pick<typeof db, "select" | "insert" | "update" | "delete">;

export async function getAccessStatus(userId: string, reader: Reader = db): Promise<AccessStatus> {
  const row = (await reader.select({ status: schema.users.accessStatus }).from(schema.users)
    .where(eq(schema.users.id, userId)).limit(1))[0];
  if (!row) throw AppError.unauthorized("User not found");
  return parseAccessStatus(row.status);
}

export const APPROVAL_REQUIRED = "approval_required";
export const ACCOUNT_LOCKED = "account_locked";

/**
 * 他人のデータ・サービスへのログイン・外部向けトークンの発行口で呼ぶ。
 * pending は approval_required、locked は account_locked で拒否する。
 */
export async function requireActiveUser(userId: string, reader: Reader = db): Promise<void> {
  const status = await getAccessStatus(userId, reader);
  if (status === "active") return;
  if (status === "pending") {
    throw AppError.withCode(403, APPROVAL_REQUIRED, "This account is waiting for approval. Request access from Cernere.");
  }
  throw AppError.withCode(403, ACCOUNT_LOCKED, "This account is locked.");
}

// ── 本人の申請 ──────────────────────────────────────────────

const purposeSchema = z.string().trim().min(1).max(500);

export interface AccessView {
  status: AccessStatus;
  request: { id: string; state: string; purpose: string; createdAt: string } | null;
}

export async function getMyAccess(userId: string): Promise<AccessView> {
  const status = await getAccessStatus(userId);
  const request = (await db.select().from(schema.registrationRequests)
    .where(eq(schema.registrationRequests.userId, userId))
    .orderBy(sql`${schema.registrationRequests.createdAt} DESC`).limit(1))[0];
  return {
    status,
    request: request
      ? { id: request.id, state: request.state, purpose: request.purpose, createdAt: request.createdAt.toISOString() }
      : null,
  };
}

/** 利用を申請する。pending だけが申請でき、未決は 1 件まで。 */
export async function applyForAccess(userId: string, purpose: string): Promise<{ requestId: string }> {
  const parsed = purposeSchema.safeParse(purpose);
  if (!parsed.success) throw AppError.badRequest("Describe how you will use Cernere (1-500 characters)");
  return db.transaction(async (tx) => {
    const user = (await tx.select({ status: schema.users.accessStatus }).from(schema.users)
      .where(eq(schema.users.id, userId)).for("update"))[0];
    if (!user || parseAccessStatus(user.status) !== "pending") throw AppError.conflict("Only accounts waiting for approval can apply");
    const open = (await tx.select({ id: schema.registrationRequests.id }).from(schema.registrationRequests).where(and(
      eq(schema.registrationRequests.userId, userId),
      eq(schema.registrationRequests.state, "open"),
    )).limit(1))[0];
    if (open) throw AppError.conflict("A request is already waiting for review");
    const requestId = crypto.randomUUID();
    await tx.insert(schema.registrationRequests).values({ id: requestId, userId, state: "open", purpose: parsed.data });
    return { requestId };
  });
}

export async function withdrawAccessRequest(userId: string): Promise<{ withdrawn: boolean }> {
  const rows = await db.update(schema.registrationRequests).set({ state: "withdrawn", decidedAt: new Date() }).where(and(
    eq(schema.registrationRequests.userId, userId),
    eq(schema.registrationRequests.state, "open"),
  )).returning({ id: schema.registrationRequests.id });
  return { withdrawn: rows.length > 0 };
}

// ── admin の決定 ────────────────────────────────────────────

export type AccessDecision = "approve" | "reject" | "lock" | "unlock";

const TRANSITIONS: Record<AccessDecision, { from: AccessStatus[]; to: AccessStatus; event: SecurityEventKind }> = {
  approve: { from: ["pending"], to: "active", event: "access.approved" },
  reject: { from: ["pending"], to: "locked", event: "access.rejected" },
  lock: { from: ["active", "pending"], to: "locked", event: "access.locked" },
  unlock: { from: ["locked"], to: "active", event: "access.unlocked" },
};

export const decisionSchema = z.object({
  userId: z.string().uuid(),
  decision: z.enum(["approve", "reject", "lock", "unlock"]),
  expectedRevision: z.number().int().min(0),
  reasonCode: z.string().trim().min(1).max(64),
}).strict();

export type DecisionInput = z.infer<typeof decisionSchema>;

async function requireActiveAdmin(actorUserId: string, reader: Reader): Promise<void> {
  const actor = (await reader.select({ role: schema.users.role, status: schema.users.accessStatus }).from(schema.users)
    .where(eq(schema.users.id, actorUserId)).limit(1))[0];
  if (actor?.role !== "admin" || parseAccessStatus(actor.status) !== "active") {
    throw AppError.forbidden("An active administrator is required");
  }
}

/** 失効の後始末: 端末・refresh・保留中の端末追加と自己回復を止める (パスキー自体は残す)。 */
async function revokeAccessArtifacts(tx: Database, userId: string, now: Date): Promise<void> {
  await tx.update(schema.deviceCredentials).set({ revokedAt: now, revokedReason: "admin" }).where(and(
    eq(schema.deviceCredentials.userId, userId),
    isNull(schema.deviceCredentials.revokedAt),
  ));
  await tx.delete(schema.refreshSessions).where(eq(schema.refreshSessions.userId, userId));
  await tx.update(schema.devicePairings).set({ revokedAt: now }).where(and(
    eq(schema.devicePairings.userId, userId),
    isNull(schema.devicePairings.approvedAt),
    isNull(schema.devicePairings.revokedAt),
  ));
  await tx.update(schema.recoveryRequests).set({ cancelledAt: now }).where(and(
    eq(schema.recoveryRequests.userId, userId),
    isNull(schema.recoveryRequests.cancelledAt),
    isNull(schema.recoveryRequests.completedAt),
  ));
}

/**
 * 許可・拒否・ロック・解除。fresh action proof (user_access.decide) は WS 層で確認済みであること。
 * 状態が変わると auth_epoch を進め、古いセッション (pending 時のものを含む) は再認証になる。
 */
export async function decideAccess(actorUserId: string, input: DecisionInput): Promise<{ status: AccessStatus; revision: number }> {
  if (actorUserId === input.userId) throw AppError.forbidden("You cannot decide your own access");
  const transition = TRANSITIONS[input.decision];
  return db.transaction(async (tx) => {
    // 2 行を掴むので id の昇順に固定してデッドロックを避ける (registration-grant と同じ方針)。
    for (const id of [actorUserId, input.userId].sort()) {
      await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, id)).for("update");
    }
    await requireActiveAdmin(actorUserId, tx);
    const target = (await tx.select().from(schema.users).where(eq(schema.users.id, input.userId)).limit(1))[0];
    if (!target) throw AppError.notFound("User not found");
    const before = parseAccessStatus(target.accessStatus);
    if (target.accessRevision !== input.expectedRevision) {
      throw AppError.withCode(409, "access_revision_conflict", "This account changed since you loaded it; reload and try again");
    }
    if (!transition.from.includes(before)) throw AppError.conflict(`Cannot ${input.decision} an account that is ${before}`);

    if (transition.to === "locked" && target.role === "admin" && before === "active") {
      const others = await tx.select({ id: schema.users.id }).from(schema.users).where(and(
        eq(schema.users.role, "admin"),
        eq(schema.users.accessStatus, "active"),
        ne(schema.users.id, target.id),
      )).limit(1);
      if (others.length === 0) throw AppError.conflict("The last active administrator cannot be locked here");
    }

    const now = new Date();
    const revision = target.accessRevision + 1;
    await tx.update(schema.users).set({
      accessStatus: transition.to,
      accessRevision: revision,
      accessChangedAt: now,
      authEpoch: target.authEpoch + 1,
      updatedAt: now,
    }).where(eq(schema.users.id, target.id));
    if (transition.to === "locked") await revokeAccessArtifacts(tx, target.id, now);

    const request = (await tx.select({ id: schema.registrationRequests.id }).from(schema.registrationRequests).where(and(
      eq(schema.registrationRequests.userId, target.id),
      eq(schema.registrationRequests.state, "open"),
    )).limit(1))[0];
    if (request && (input.decision === "approve" || input.decision === "reject" || input.decision === "lock")) {
      await tx.update(schema.registrationRequests).set({
        state: input.decision === "approve" ? "approved" : "rejected",
        decidedAt: now,
      }).where(eq(schema.registrationRequests.id, request.id));
    }
    await tx.insert(schema.accessDecisions).values({
      id: crypto.randomUUID(),
      actorUserId,
      targetUserId: target.id,
      expectedRevision: input.expectedRevision,
      beforeStatus: before,
      afterStatus: transition.to,
      reasonCode: input.reasonCode,
      requestId: request?.id ?? null,
      createdAt: now,
    });
    await recordSecurityEvent(tx, target.id, transition.event);
    return { status: transition.to, revision };
  });
}

export interface AccessReviewItem {
  userId: string;
  displayName: string;
  status: AccessStatus;
  revision: number;
  createdAt: string;
  request: { id: string; purpose: string; createdAt: string } | null;
}

/** admin 用: 審査待ちの申請と、状態ごとのユーザー一覧。 */
export async function listAccessReview(actorUserId: string, status: AccessStatus | "requests"): Promise<AccessReviewItem[]> {
  await requireActiveAdmin(actorUserId, db);
  const rows = await db.select({
    userId: schema.users.id,
    displayName: schema.users.displayName,
    status: schema.users.accessStatus,
    revision: schema.users.accessRevision,
    createdAt: schema.users.createdAt,
    requestId: schema.registrationRequests.id,
    purpose: schema.registrationRequests.purpose,
    requestedAt: schema.registrationRequests.createdAt,
  }).from(schema.users)
    .leftJoin(schema.registrationRequests, and(
      eq(schema.registrationRequests.userId, schema.users.id),
      eq(schema.registrationRequests.state, "open"),
    ))
    .where(status === "requests"
      ? sql`${schema.registrationRequests.id} IS NOT NULL`
      : eq(schema.users.accessStatus, status))
    .orderBy(asc(schema.users.createdAt))
    .limit(200);
  return rows.map((r) => ({
    userId: r.userId,
    displayName: r.displayName,
    status: parseAccessStatus(r.status),
    revision: r.revision,
    createdAt: r.createdAt.toISOString(),
    request: r.requestId ? { id: r.requestId, purpose: r.purpose ?? "", createdAt: r.requestedAt!.toISOString() } : null,
  }));
}
