/**
 * パスキー signup (signup-finish / composite-signup-finish) の venueChallengeId 分岐
 * (spec/feature/venue-network-registration.md §6)。
 *
 *   venueChallengeId が verified・未消費・期限内 → challenge を消費し、active・venue・組織の member で作る
 *   指定なし                                   → 従来どおり pending・outside_venue・組織なし
 *   指定ありで無効                             → 422 venue_challenge_invalid。何も作らない
 *
 * precheck は WebAuthn ceremony を消費する前に無効な指定を弾く (端末が指定を外して選び直せるように)。
 * 確定は user / passkey の挿入と同じトランザクションで行い、並行した 2 つ目の消費は 422 で巻き戻す。
 * @implements SPEC-VENUE-REGISTRATION
 */

import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { venueSignupOutcome, type VenueSignupOutcome } from "./venue-challenge-state.js";
import { consumeVenueChallenge, readVenueChallenge } from "./venue-challenge-store.js";

export const VENUE_CHALLENGE_INVALID = "venue_challenge_invalid";
export const VENUE_REGISTRATION_REASON = "venue_registration";

type SignupTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function venueChallengeInvalid(): AppError {
  return AppError.withCode(422, VENUE_CHALLENGE_INVALID, VENUE_CHALLENGE_INVALID);
}

/** ceremony を消費する前の確認。指定なしは outside_venue、無効な指定は 422。 */
export async function precheckVenueSignup(venueChallengeId: string | undefined, now = new Date()): Promise<VenueSignupOutcome> {
  const row = venueChallengeId === undefined ? null : await readVenueChallenge(venueChallengeId);
  const outcome = venueSignupOutcome(venueChallengeId, row, now);
  if (outcome.kind === "invalid") throw venueChallengeInvalid();
  return outcome;
}

export interface VenueSignupResult { origin: "venue" | "outside_venue"; placeId: string | null }

/**
 * user 行の挿入直後、同じトランザクションで呼ぶ。
 * venue のときは challenge を消費し、許可と組織への所属を記録する (自動承認の根拠は venue attestation だけ)。
 */
export async function applyVenueSignup(tx: SignupTx, userId: string, outcome: VenueSignupOutcome, now: Date): Promise<VenueSignupResult> {
  if (outcome.kind === "invalid") throw venueChallengeInvalid();
  if (outcome.kind === "outside_venue") {
    await tx.update(schema.users).set({ registrationOrigin: "outside_venue" }).where(eq(schema.users.id, userId));
    return { origin: "outside_venue", placeId: null };
  }
  const placeId = await consumeVenueChallenge(outcome.challengeId, now, tx);
  // 確認後に別の signup が先に消費した・期限が切れた。ここで作ると 1 回の確認で 2 人入れてしまう。
  if (!placeId) throw venueChallengeInvalid();
  await tx.update(schema.users).set({
    registrationOrigin: "venue",
    registrationPlaceId: placeId,
    accessStatus: "active",
    accessRevision: 1,
    accessChangedAt: now,
  }).where(eq(schema.users.id, userId));
  await tx.insert(schema.organizationMembers).values({ organizationId: placeId, userId, role: "member", joinedAt: now })
    .onConflictDoNothing();
  // 許可の監査 (actor なし = 会場確認による自動許可)。
  await tx.insert(schema.accessDecisions).values({
    id: crypto.randomUUID(), actorUserId: null, targetUserId: userId, expectedRevision: 0,
    beforeStatus: "pending", afterStatus: "active", reasonCode: VENUE_REGISTRATION_REASON, requestId: null, createdAt: now,
  });
  return { origin: "venue", placeId };
}
