/**
 * 現地確認 MFA の kiosk 公開鍵レジストリ (契約 B、 Cernere が持つ)。
 *
 * Aedilis の gateway registry とは共有しない。 登録・失効は admin API からだけ行い、
 * Ostiarius からの自己登録経路は持たない。 失効は論理状態で、 revoked の lanId は
 * 再登録で active に戻さない (鍵漏えいで失効した kiosk を同じ名前で復活させない)。
 * @implements SPEC-MFA-ONSITE
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "../db/connection.js";
import { onsiteKiosks } from "../db/schema.js";
import { AppError } from "../error.js";
import type { OnsiteKioskInput } from "./onsite-kiosk-input.js";

export type OnsiteKioskRow = typeof onsiteKiosks.$inferSelect;
export type OnsiteKioskStatus = "active" | "revoked";

/** 利用者端末へ渡す公開情報。 公開鍵は端末に不要なので含めない。 */
export interface OnsiteKioskPublic { lanId: string; placeId: string; lanUrl: string; label: string | null }

type Database = typeof defaultDb;

export function publicOnsiteKiosk(row: OnsiteKioskRow): OnsiteKioskPublic {
  return { lanId: row.lanId, placeId: row.placeId, lanUrl: row.lanUrl, label: row.label };
}

/** upsert。 active 行だけを更新し、 revoked 行に当たったら 409 で新しい lanId を求める。 */
export async function registerOnsiteKiosk(input: OnsiteKioskInput, now = new Date(), database: Database = defaultDb): Promise<OnsiteKioskRow> {
  const rows = await database.insert(onsiteKiosks).values({
    lanId: input.lanId, placeId: input.placeId, publicKeyPem: input.publicKeyPem, lanUrl: input.lanUrl,
    label: input.label, status: "active", createdAt: now, updatedAt: now, revokedAt: null,
  }).onConflictDoUpdate({
    target: onsiteKiosks.lanId,
    set: { placeId: input.placeId, publicKeyPem: input.publicKeyPem, lanUrl: input.lanUrl, label: input.label, updatedAt: now },
    // Atomic with a concurrent revoke: a revoked row never matches, so it stays revoked.
    setWhere: sql`${onsiteKiosks.status} = 'active'`,
  }).returning();
  const row = rows[0];
  if (!row) throw AppError.conflict("This lanId is revoked. Register the kiosk under a new lanId.");
  return row;
}

export async function listOnsiteKiosks(database: Database = defaultDb): Promise<OnsiteKioskRow[]> {
  return database.select().from(onsiteKiosks).orderBy(asc(onsiteKiosks.placeId), asc(onsiteKiosks.lanId));
}

/** 冪等。 既に revoked なら最初の失効時刻を保つ。 */
export async function revokeOnsiteKiosk(lanId: string, now = new Date(), database: Database = defaultDb): Promise<OnsiteKioskRow> {
  const rows = await database.update(onsiteKiosks)
    .set({ status: "revoked", revokedAt: sql`COALESCE(${onsiteKiosks.revokedAt}, ${now.toISOString()}::timestamptz)`, updatedAt: now })
    .where(eq(onsiteKiosks.lanId, lanId))
    .returning();
  const row = rows[0];
  if (!row) throw AppError.notFound("Onsite kiosk not found");
  return row;
}

export async function findOnsiteKiosk(lanId: string, database: Database = defaultDb): Promise<OnsiteKioskRow | null> {
  const rows = await database.select().from(onsiteKiosks).where(eq(onsiteKiosks.lanId, lanId)).limit(1);
  return rows[0] ?? null;
}

/** allowedPlaceIds=null は全 active kiosk。 */
export async function listActiveOnsiteKiosks(allowedPlaceIds: readonly string[] | null, database: Database = defaultDb): Promise<OnsiteKioskRow[]> {
  const active = eq(onsiteKiosks.status, "active");
  const where = allowedPlaceIds ? and(active, inArray(onsiteKiosks.placeId, [...allowedPlaceIds])) : active;
  return database.select().from(onsiteKiosks).where(where).orderBy(asc(onsiteKiosks.placeId), asc(onsiteKiosks.lanId));
}
