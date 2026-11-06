/**
 * 会場ネットワーク限定の新規登録の challenge 開始・kiosk attestation の受理・状態確認
 * (spec/feature/venue-network-registration.md §2 / §6)。
 *
 *   登録画面   → startVenueRegistration(ip)          challenge と nonce と候補 kiosk を返す
 *   Ostiarius  → submitVenueAttestation(token)       §3 の検証後、challenge を確認済みにする
 *   登録画面   → venueRegistrationStatus(id)          pending / verified / expired (場所は返さない)
 *   signup     → venue-registration-signup.ts         確認済み challenge の一回消費
 *
 * kiosk レジストリは SPEC-MFA-ONSITE の onsite_kiosks をそのまま使う。
 * @implements SPEC-VENUE-REGISTRATION
 */

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/connection.js";
import { organizations } from "../db/schema.js";
import { AppError } from "../error.js";
import { rateLimitSubject, wideRateLimitSubject } from "../http/rate-limit-subject.js";
import { logAuthEvent } from "../logging/auth-logger.js";
import { checkRateLimit } from "../redis.js";
import { onsiteAttestationError } from "./onsite-attestation.js";
import { findOnsiteKiosk, listActiveOnsiteKiosks, publicOnsiteKiosk, type OnsiteKioskPublic } from "./onsite-kiosk-registry.js";
import { checkVenueAttestation, type VenueAttestationDeps } from "./venue-attestation.js";
import { venueChallengeState, type VenueChallengeState } from "./venue-challenge-state.js";
import { issueVenueChallenge, lookupVenueNonce, markVenueChallengeVerified, readVenueChallenge } from "./venue-challenge-store.js";

export interface VenueStartResult { challengeId: string; nonce: string; expiresAt: string; kiosks: OnsiteKioskPublic[] }

/** 未認証で呼べるので、接続元ごと・広いまとまりごとに発行数を絞る。 */
async function limitVenueStart(ip: string | undefined): Promise<void> {
  await checkRateLimit(`venue-registration-start:${rateLimitSubject(ip)}`, 20, 600);
  await checkRateLimit(`venue-registration-start:wide:${wideRateLimitSubject(ip)}`, 300, 600);
}

export async function startVenueRegistration(ip: string | undefined, now = new Date()): Promise<VenueStartResult> {
  await limitVenueStart(ip);
  const kiosks = await listActiveOnsiteKiosks(null);
  // kiosk が無ければ確認は成立しない。空の待ちを返さずに 503 にする。
  if (kiosks.length === 0) throw AppError.serviceUnavailable("No venue kiosk is available");
  const issued = await issueVenueChallenge(now);
  return {
    challengeId: issued.challengeId, nonce: issued.nonce, expiresAt: issued.expiresAt.toISOString(),
    kiosks: kiosks.map(publicOnsiteKiosk),
  };
}

async function organizationExists(placeId: string): Promise<boolean> {
  const rows = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, placeId)).limit(1);
  return rows.length > 0;
}

function attestationDeps(now: Date): VenueAttestationDeps {
  return {
    findKiosk: findOnsiteKiosk,
    lookupNonce: (nonce) => lookupVenueNonce(nonce, now),
    organizationExists,
    now: () => now.getTime(),
  };
}

export async function submitVenueAttestation(attestation: unknown, submitter: string, now = new Date()): Promise<{ accepted: true }> {
  let accepted;
  try {
    accepted = await checkVenueAttestation(attestation, attestationDeps(now));
  } catch (error) {
    logAuthEvent({ event: "user.venue_registration.rejected", provider: "onsite", submitter,
      error: error instanceof AppError ? error.code ?? error.message : "internal" });
    throw error;
  }
  const result = await markVenueChallengeVerified(accepted.challengeId, { lanId: accepted.lanId, placeId: accepted.placeId }, now);
  if (result === "used") throw onsiteAttestationError("nonce_used");
  logAuthEvent({ event: "user.venue_registration.verified", provider: "onsite", submitter,
    placeId: accepted.placeId, lanId: accepted.lanId });
  return { accepted: true };
}

const challengeIdSchema = z.string().uuid();

export async function venueRegistrationStatus(challengeId: unknown, now = new Date()): Promise<{ state: VenueChallengeState }> {
  const parsed = challengeIdSchema.safeParse(challengeId);
  if (!parsed.success) throw AppError.badRequest("challengeId is required");
  return { state: venueChallengeState(await readVenueChallenge(parsed.data), now) };
}
