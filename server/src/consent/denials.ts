/**
 * 推奨権限の拒否の読み取り (設計書 §5.3)。
 *
 * 拒否は既存の user_data_optouts と同じ表に置く:
 *   user_data.module:<m>        → category `module:<m>` (既存の module opt-out そのもの)
 *   profile.* / identity_claim.* / oidc.* → category `consent:<permission key>`
 * service_id は project なら managed_projects.key、OIDC client なら `oidc:<client_id>`。
 *
 * データを渡す側 (profile / identity claim / user_data / OIDC claim) はここで拒否を確かめる。
 */

import { and, eq, inArray, like } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import type { ConsentSubject } from "./store.js";

export const CONSENT_OPTOUT_PREFIX = "consent:";
const MODULE_OPTOUT_PREFIX = "module:";

export function consentOptoutCategory(permissionKey: string): string {
  return `${CONSENT_OPTOUT_PREFIX}${permissionKey}`;
}

/** user_data_optouts.service_id。OIDC client は project key と衝突しないよう接頭辞を付ける。 */
export function consentServiceId(subject: ConsentSubject): string {
  return subject.kind === "project" ? subject.key : `oidc:${subject.key}`;
}

/** opt-out の category から権限キーへ。consent に関係しない category は null。 */
export function permissionKeyFromCategory(categoryKey: string): string | null {
  if (categoryKey.startsWith(CONSENT_OPTOUT_PREFIX)) return categoryKey.slice(CONSENT_OPTOUT_PREFIX.length);
  if (categoryKey.startsWith(MODULE_OPTOUT_PREFIX)) return `user_data.module:${categoryKey.slice(MODULE_OPTOUT_PREFIX.length)}`;
  return null;
}

/** 利用者がそのサービスに対して拒否している権限キーの集合。 */
export async function deniedPermissionKeys(userId: string, serviceId: string): Promise<Set<string>> {
  const rows = await db.select({ categoryKey: schema.userDataOptouts.categoryKey })
    .from(schema.userDataOptouts)
    .where(and(eq(schema.userDataOptouts.userId, userId), eq(schema.userDataOptouts.serviceId, serviceId)));
  const keys = new Set<string>();
  for (const row of rows) {
    const key = permissionKeyFromCategory(row.categoryKey);
    if (key) keys.add(key);
  }
  return keys;
}

/** 複数利用者の identity claim の拒否 (横断検索の結果を伏せる用)。userId → 拒否した claim 名。 */
export async function deniedClaimsByUser(userIds: readonly string[], serviceId: string): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (userIds.length === 0) return result;
  const prefix = consentOptoutCategory("identity_claim.");
  const rows = await db.select({ userId: schema.userDataOptouts.userId, categoryKey: schema.userDataOptouts.categoryKey })
    .from(schema.userDataOptouts)
    .where(and(
      inArray(schema.userDataOptouts.userId, [...userIds]),
      eq(schema.userDataOptouts.serviceId, serviceId),
      like(schema.userDataOptouts.categoryKey, `${prefix}%`),
    ));
  for (const row of rows) {
    const claims = result.get(row.userId) ?? new Set<string>();
    claims.add(row.categoryKey.slice(prefix.length));
    result.set(row.userId, claims);
  }
  return result;
}

/** 拒否した権限を除いた OIDC scope (openid は identity.basic なので常に残る)。 */
export function filterDeniedOidcScopes(scope: readonly string[], denied: ReadonlySet<string>): string[] {
  return scope.filter((s) => s === "openid" || !denied.has(`oidc.${s}`));
}
