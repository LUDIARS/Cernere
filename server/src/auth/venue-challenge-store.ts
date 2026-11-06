/**
 * venue_registration_challenges の永続化 (migration 080)。
 *
 * - nonce は 32 byte 乱数 base64url。平文は発行応答だけで返し、DB には SHA-256 を置く。
 * - 確認 (verified) と消費 (consumed) はどちらも条件付き UPDATE で一度だけ遷移させる。
 * - 期限切れの行は 1 日後に回収する。
 * @implements SPEC-VENUE-REGISTRATION
 */

import crypto from "node:crypto";
import { and, eq, gt, isNull, isNotNull, lt } from "drizzle-orm";
import { db as defaultDb } from "../db/connection.js";
import { venueRegistrationChallenges } from "../db/schema.js";
import type { VenueChallengeRow } from "./venue-challenge-state.js";
import type { VenueNonceLookup } from "./venue-attestation.js";

export const VENUE_CHALLENGE_TTL_MS = 5 * 60_000;
export const VENUE_CHALLENGE_RETENTION_MS = 24 * 60 * 60_000;

type Database = typeof defaultDb;
/** signup のトランザクションでも使えるように、必要な操作だけを受ける。 */
type Writer = Pick<Database, "update">;

export function hashVenueNonce(nonce: string): string {
  return crypto.createHash("sha256").update(nonce).digest("hex");
}

export interface IssuedVenueChallenge { challengeId: string; nonce: string; expiresAt: Date }

export async function issueVenueChallenge(now = new Date(), database: Database = defaultDb,
  random: (size: number) => Buffer = crypto.randomBytes): Promise<IssuedVenueChallenge> {
  const challengeId = crypto.randomUUID();
  const nonce = random(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + VENUE_CHALLENGE_TTL_MS);
  await database.insert(venueRegistrationChallenges).values({
    id: challengeId, nonceHash: hashVenueNonce(nonce), expiresAt, createdAt: now,
  });
  return { challengeId, nonce, expiresAt };
}

/** attestation の nonce を引く。確認済み・消費済み・期限切れは再利用させない。 */
export async function lookupVenueNonce(nonce: string, now = new Date(), database: Database = defaultDb): Promise<VenueNonceLookup> {
  const row = (await database.select().from(venueRegistrationChallenges)
    .where(eq(venueRegistrationChallenges.nonceHash, hashVenueNonce(nonce))).limit(1))[0];
  if (!row || row.expiresAt.getTime() <= now.getTime()) return { state: "unknown" };
  if (row.verifiedAt || row.consumedAt) return { state: "used" };
  return { state: "active", challengeId: row.id };
}

export type VenueVerifyResult = "verified" | "used";

/** 未確認・未消費・期限内の行だけを確認済みにする (nonce の一回消費)。 */
export async function markVenueChallengeVerified(challengeId: string, place: { lanId: string; placeId: string },
  now = new Date(), database: Database = defaultDb): Promise<VenueVerifyResult> {
  const rows = await database.update(venueRegistrationChallenges)
    .set({ verifiedAt: now, lanId: place.lanId, placeId: place.placeId })
    .where(and(
      eq(venueRegistrationChallenges.id, challengeId),
      isNull(venueRegistrationChallenges.verifiedAt),
      isNull(venueRegistrationChallenges.consumedAt),
      gt(venueRegistrationChallenges.expiresAt, now),
    ))
    .returning({ id: venueRegistrationChallenges.id });
  return rows.length > 0 ? "verified" : "used";
}

export async function readVenueChallenge(challengeId: string, database: Pick<Database, "select"> = defaultDb): Promise<VenueChallengeRow | null> {
  const row = (await database.select({
    id: venueRegistrationChallenges.id,
    expiresAt: venueRegistrationChallenges.expiresAt,
    verifiedAt: venueRegistrationChallenges.verifiedAt,
    placeId: venueRegistrationChallenges.placeId,
    consumedAt: venueRegistrationChallenges.consumedAt,
  }).from(venueRegistrationChallenges).where(eq(venueRegistrationChallenges.id, challengeId)).limit(1))[0];
  return row ?? null;
}

/** 確認済み・未消費・期限内の行を消費する。並行した 2 つ目の signup は null になる。 */
export async function consumeVenueChallenge(challengeId: string, now: Date, writer: Writer): Promise<string | null> {
  const rows = await writer.update(venueRegistrationChallenges)
    .set({ consumedAt: now })
    .where(and(
      eq(venueRegistrationChallenges.id, challengeId),
      isNotNull(venueRegistrationChallenges.verifiedAt),
      isNull(venueRegistrationChallenges.consumedAt),
      gt(venueRegistrationChallenges.expiresAt, now),
    ))
    .returning({ placeId: venueRegistrationChallenges.placeId });
  return rows[0]?.placeId ?? null;
}

/** 期限から 1 日を過ぎた行を回収する。 */
export async function purgeExpiredVenueChallenges(now = new Date(), database: Database = defaultDb): Promise<number> {
  const cutoff = new Date(now.getTime() - VENUE_CHALLENGE_RETENTION_MS);
  const rows = await database.delete(venueRegistrationChallenges)
    .where(lt(venueRegistrationChallenges.expiresAt, cutoff))
    .returning({ id: venueRegistrationChallenges.id });
  return rows.length;
}
