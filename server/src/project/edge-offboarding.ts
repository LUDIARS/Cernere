/**
 * 退職者の棚卸しと削除 (spec/feature/edge-assertion-login.md §5.4)
 *
 * Cernere は退職を能動的に知らない (IdP から消えても通知は来ない) ので、
 * `edge_identities.last_seen_at` を根拠に棚卸しリストを出し、 admin が判断して消す。
 *
 * 削除自体は既存の `deleteUserAccount()` を再利用する。 あちらが CASCADE を持たない
 * 参照 (operation_logs / project_definition_history) を先処理済みで、 個人データを
 * 残さない方針も確立しているため、 ここで並行する削除経路を作らない。
 *
 * ただし `organizations.created_by` は FK のままで、 そのままだと生の外部キー違反に
 * なる。 組織を持つユーザは分かりやすく `owns_organizations` で先に拒否する
 * (fail-closed。 組織を道連れに消さない)。
 */

import { and, desc, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as dbSchema from "../db/schema.js";
import { AppError } from "../error.js";
import { deleteUserAccount } from "./service.js";

const DEFAULT_STALE_DAYS = 90;
const MAX_STALE_DAYS = 3650;
const STALE_LIMIT = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface StaleIdentity {
  userId: string;
  email: string;
  displayName: string;
  teamDomain: string;
  lastSeenAt: string;
  daysSinceSeen: number;
}

/** 指定日数以上ログインの無い identity を棚卸し候補として返す。 */
export async function listStaleIdentities(
  days: number = DEFAULT_STALE_DAYS,
  now: number = Date.now(),
): Promise<{ days: number; items: StaleIdentity[] }> {
  if (!Number.isInteger(days) || days < 1 || days > MAX_STALE_DAYS) {
    throw AppError.badRequest(`days must be an integer between 1 and ${MAX_STALE_DAYS}`);
  }
  const cutoff = new Date(now - days * DAY_MS);

  const rows = await db.select({
    userId: dbSchema.edgeIdentities.userId,
    email: dbSchema.edgeIdentities.email,
    teamDomain: dbSchema.edgeIdentities.teamDomain,
    lastSeenAt: dbSchema.edgeIdentities.lastSeenAt,
    displayName: dbSchema.users.displayName,
  }).from(dbSchema.edgeIdentities)
    .innerJoin(dbSchema.users, eq(dbSchema.users.id, dbSchema.edgeIdentities.userId))
    .where(and(
      isNotNull(dbSchema.edgeIdentities.lastSeenAt),
      lt(dbSchema.edgeIdentities.lastSeenAt, cutoff),
    ))
    .orderBy(desc(dbSchema.edgeIdentities.lastSeenAt))
    .limit(STALE_LIMIT);

  const items = rows.map((row) => {
    const lastSeen = row.lastSeenAt as Date;
    return {
      userId: row.userId,
      email: row.email,
      displayName: row.displayName ?? "",
      teamDomain: row.teamDomain,
      lastSeenAt: lastSeen.toISOString(),
      daysSinceSeen: Math.floor((now - lastSeen.getTime()) / DAY_MS),
    };
  });

  return { days, items };
}

/**
 * 退職者の個人データを削除する。
 *
 * 誤削除は復旧できないので、 呼び出し側は対象の email を `confirmEmail` として
 * 復唱する。 一致しなければ実行しない。 step-up (passkey) の検証は WS の
 * action proof 層が済ませている前提。
 */
export async function purgeEdgeUser(
  userId: string,
  confirmEmail: string,
): Promise<{ ok: true; userId: string; email: string }> {
  const users = await db.select({
    id: dbSchema.users.id,
    email: dbSchema.users.email,
  }).from(dbSchema.users).where(eq(dbSchema.users.id, userId)).limit(1);

  const user = users[0];
  if (!user) throw AppError.notFound("User not found");

  const email = (user.email ?? "").trim().toLowerCase();
  if (email === "" || email !== confirmEmail.trim().toLowerCase()) {
    throw AppError.badRequest("confirmEmail does not match the target user");
  }

  const ownedOrgs = await db.select({ id: dbSchema.organizations.id })
    .from(dbSchema.organizations)
    .where(eq(dbSchema.organizations.createdBy, userId));
  if (ownedOrgs.length > 0) {
    throw AppError.conflict(
      `owns_organizations: transfer ownership first (${ownedOrgs.map((o) => o.id).join(", ")})`,
    );
  }

  await deleteUserAccount(userId);
  return { ok: true, userId, email };
}
