/**
 * 有効な role の読み出し (spec/plan/2026-10-15-account-federation-design.md §3.1)。
 *
 * Cernere 内の権限判定 (トークンの role・me 応答・system admin 判定) はここを通す。
 * 判定規則は role-policy.ts の pickEffectiveRole。subject.ts / auth/user-access.ts からも
 * 呼ばれるため、それらを import しない (循環を作らない)。
 */

import { eq } from "drizzle-orm";

import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { pickEffectiveRole, type FederationPrimaryRole } from "./role-policy.js";

type Reader = Pick<typeof db, "select">;

/** アカウントが連携していれば、その主の role と許可状態 (自分が主・未連携なら null)。 */
export async function loadFederationPrimaryRole(userId: string, reader: Reader = db): Promise<FederationPrimaryRole | null> {
  const membership = (await reader.select({ primaryUserId: schema.accountFederations.primaryUserId })
    .from(schema.accountFederationMembers)
    .innerJoin(schema.accountFederations, eq(schema.accountFederationMembers.federationId, schema.accountFederations.id))
    .where(eq(schema.accountFederationMembers.userId, userId)).limit(1))[0];
  const primaryUserId = membership?.primaryUserId;
  if (typeof primaryUserId !== "string" || primaryUserId === userId) return null;
  const primary = (await reader.select({ role: schema.users.role, accessStatus: schema.users.accessStatus })
    .from(schema.users).where(eq(schema.users.id, primaryUserId)).limit(1))[0];
  return { primaryUserId, role: primary?.role ?? null, accessStatus: primary?.accessStatus ?? null };
}

/** 自分の role を既に読んであるときの有効な role。 */
export async function resolveEffectiveRole(userId: string, ownRole: string, reader: Reader = db): Promise<string> {
  return pickEffectiveRole(userId, ownRole, await loadFederationPrimaryRole(userId, reader));
}

/** アカウントの有効な role (アカウントが無ければ null)。 */
export async function loadEffectiveRole(userId: string, reader: Reader = db): Promise<string | null> {
  const own = (await reader.select({ role: schema.users.role }).from(schema.users)
    .where(eq(schema.users.id, userId)).limit(1))[0];
  if (!own) return null;
  return resolveEffectiveRole(userId, own.role ?? "general", reader);
}

/** system admin として扱うか (連携していれば主が admin か)。 */
export async function isEffectiveAdmin(userId: string, reader: Reader = db): Promise<boolean> {
  return (await loadEffectiveRole(userId, reader)) === "admin";
}
