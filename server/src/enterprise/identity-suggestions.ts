/**
 * 企業認証の対応付けの提案 (Concordia spec/plan/2026-10-15-cf-cernere-sso.md Cr-2)。
 *
 * 対応付けの無い Cloudflare subject でログインが来て、署名付き Access JWT の cr_user_id が
 * その接続の組織メンバーなら「この subject はこの人」という提案を記録する。Cloudflare の
 * ログイン先が Cernere の OIDC (cr_user_id はパスキーでログインした本人) である前提で、
 * 管理者は Cloudflare の subject UUID を調べて手入力せずに済む。
 * 確定は管理者の操作 (enterprise.save_identity の action proof) で行い、確定まではセッションを出さない。
 */

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../db/connection.js";
import {
  enterpriseConnections,
  enterpriseIdentities,
  enterpriseIdentitySuggestions,
  organizationMembers,
  users,
} from "../db/schema.js";
import { AppError } from "../error.js";

/** 対応付けが無いログインのとき呼ぶ。メンバーでなければ何もしない (提案にしない)。 */
export async function recordIdentitySuggestion(projectKey: string, subjectHash: string, userId: string): Promise<void> {
  const connection = (await db.select({ organizationId: enterpriseConnections.organizationId }).from(enterpriseConnections)
    .where(eq(enterpriseConnections.projectKey, projectKey)).limit(1))[0];
  if (!connection) return;
  const member = (await db.select({ userId: organizationMembers.userId }).from(organizationMembers).where(and(
    eq(organizationMembers.organizationId, connection.organizationId),
    eq(organizationMembers.userId, userId),
  )).limit(1))[0];
  if (!member) return;
  await db.insert(enterpriseIdentitySuggestions).values({ projectKey, subjectHash, userId })
    .onConflictDoUpdate({
      target: [enterpriseIdentitySuggestions.projectKey, enterpriseIdentitySuggestions.subjectHash],
      set: { userId, lastSeenAt: sql`now()` },
    });
}

export interface IdentitySuggestion {
  projectKey: string;
  subjectHash: string;
  userId: string;
  name: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export async function listIdentitySuggestions(): Promise<IdentitySuggestion[]> {
  const rows = await db.select({
    projectKey: enterpriseIdentitySuggestions.projectKey,
    subjectHash: enterpriseIdentitySuggestions.subjectHash,
    userId: enterpriseIdentitySuggestions.userId,
    name: users.displayName,
    firstSeenAt: enterpriseIdentitySuggestions.firstSeenAt,
    lastSeenAt: enterpriseIdentitySuggestions.lastSeenAt,
  }).from(enterpriseIdentitySuggestions).innerJoin(users, eq(users.id, enterpriseIdentitySuggestions.userId));
  return rows.map((r) => ({ ...r, firstSeenAt: r.firstSeenAt.toISOString(), lastSeenAt: r.lastSeenAt.toISOString() }));
}

/**
 * 提案を確定して対応付けにする。手入力の save_identity と同じ条件 (組織メンバー、別人に割り当て済みでない)
 * を確かめ、同じトランザクションで提案を消す。action proof は WS 層で確認済みであること。
 */
export async function acceptIdentitySuggestion(projectKey: string, userId: string, subjectHash: string): Promise<void> {
  await db.transaction(async (tx) => {
    const suggestion = (await tx.select().from(enterpriseIdentitySuggestions).where(and(
      eq(enterpriseIdentitySuggestions.projectKey, projectKey),
      eq(enterpriseIdentitySuggestions.subjectHash, subjectHash),
    )).for("update"))[0];
    if (!suggestion || suggestion.userId !== userId) throw AppError.notFound("This suggestion no longer exists; reload");
    const connection = (await tx.select().from(enterpriseConnections).where(eq(enterpriseConnections.projectKey, projectKey)).for("share"))[0];
    if (!connection) throw AppError.notFound("Enterprise connection not found");
    const member = (await tx.select().from(organizationMembers).where(and(
      eq(organizationMembers.organizationId, connection.organizationId),
      eq(organizationMembers.userId, userId),
    )).for("share"))[0];
    if (!member) throw AppError.badRequest("Add this user to the organization first");
    const existing = (await tx.select().from(enterpriseIdentities).where(and(
      eq(enterpriseIdentities.projectKey, projectKey),
      eq(enterpriseIdentities.subjectHash, subjectHash),
    )).for("update"))[0];
    if (existing && existing.userId !== userId) throw AppError.conflict("Cloudflare subject is already assigned");
    await tx.delete(enterpriseIdentities).where(and(eq(enterpriseIdentities.projectKey, projectKey), eq(enterpriseIdentities.userId, userId)));
    await tx.insert(enterpriseIdentities).values({ projectKey, userId, subjectHash, isActive: true, revision: randomUUID() });
    await tx.delete(enterpriseIdentitySuggestions).where(and(
      eq(enterpriseIdentitySuggestions.projectKey, projectKey),
      eq(enterpriseIdentitySuggestions.subjectHash, subjectHash),
    ));
  });
}
