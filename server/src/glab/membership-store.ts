/**
 * glab_memberships / glab_github_repos の永続化 (migration 082)。
 * @implements SPEC-GLAB-MEMBERSHIP-GITHUB
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import type { GlabMembershipRecord, GlabStatus } from "./membership-policy.js";

export interface GlabMemberRow {
  userId: string;
  displayName: string;
  orgRole: string;
  githubId: number | null;
  membership: (GlabMembershipRecord & { githubSyncedAt: Date | null; githubSyncError: string | null }) | null;
}

export async function listGlabMembers(organizationId: string): Promise<GlabMemberRow[]> {
  const rows = await db.select({
    userId: schema.users.id,
    displayName: schema.users.displayName,
    orgRole: schema.organizationMembers.role,
    githubId: schema.users.githubId,
    status: schema.glabMemberships.status,
    joinedAt: schema.glabMemberships.joinedAt,
    alumniAt: schema.glabMemberships.alumniAt,
    githubSyncedAt: schema.glabMemberships.githubSyncedAt,
    githubSyncError: schema.glabMemberships.githubSyncError,
  }).from(schema.organizationMembers)
    .innerJoin(schema.users, eq(schema.organizationMembers.userId, schema.users.id))
    .leftJoin(schema.glabMemberships, and(
      eq(schema.glabMemberships.organizationId, schema.organizationMembers.organizationId),
      eq(schema.glabMemberships.userId, schema.organizationMembers.userId),
    ))
    .where(eq(schema.organizationMembers.organizationId, organizationId));
  return rows.map((r) => ({
    userId: r.userId,
    displayName: r.displayName,
    orgRole: r.orgRole,
    githubId: r.githubId ?? null,
    membership: r.status && r.joinedAt ? {
      status: r.status as GlabStatus,
      joinedAt: r.joinedAt,
      alumniAt: r.alumniAt ?? null,
      githubSyncedAt: r.githubSyncedAt ?? null,
      githubSyncError: r.githubSyncError ?? null,
    } : null,
  }));
}

export async function readGlabMember(organizationId: string, userId: string): Promise<GlabMemberRow | null> {
  return (await listGlabMembers(organizationId)).find((m) => m.userId === userId) ?? null;
}

export async function saveGlabMembership(organizationId: string, userId: string, next: GlabMembershipRecord,
  actorUserId: string, now = new Date()): Promise<void> {
  const values = { status: next.status, joinedAt: next.joinedAt, alumniAt: next.alumniAt, updatedBy: actorUserId, updatedAt: now };
  await db.insert(schema.glabMemberships).values({ organizationId, userId, ...values })
    .onConflictDoUpdate({ target: [schema.glabMemberships.organizationId, schema.glabMemberships.userId], set: values });
}

export async function recordGithubSync(organizationId: string, userId: string, error: string | null, now = new Date()): Promise<void> {
  await db.update(schema.glabMemberships)
    .set(error ? { githubSyncError: error } : { githubSyncedAt: now, githubSyncError: null })
    .where(and(eq(schema.glabMemberships.organizationId, organizationId), eq(schema.glabMemberships.userId, userId)));
}

/** GitHub の数値 ID から GLab の在籍区分を引く (webhook の作成者判定)。 */
export async function statusForGithubId(organizationId: string, githubId: number): Promise<{ userId: string; status: GlabStatus } | null> {
  const rows = await db.select({ userId: schema.users.id, status: schema.glabMemberships.status })
    .from(schema.users)
    .innerJoin(schema.glabMemberships, and(
      eq(schema.glabMemberships.userId, schema.users.id),
      eq(schema.glabMemberships.organizationId, organizationId),
    ))
    .where(eq(schema.users.githubId, githubId)).limit(1);
  return rows[0] ? { userId: rows[0].userId, status: rows[0].status as GlabStatus } : null;
}

export async function recordGithubRepo(row: { repoFullName: string; creatorGithubId: number | null; creatorUserId: string | null;
  creatorStatus: GlabStatus | null; grantedAt: Date | null }): Promise<void> {
  await db.insert(schema.glabGithubRepos).values(row).onConflictDoNothing();
}
