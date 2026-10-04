/**
 * 現地確認 MFA の challenge 開始と kiosk attestation の受理 (契約 C、 SPEC-MFA-ONSITE)。
 *
 *   利用者端末 → startOnsiteChallenge(mfaToken)       nonce と候補 kiosk を返す
 *   Ostiarius  → submitOnsiteAttestation(attestation)  §4.2 の検証後、 ticket に充足を記録する
 *   利用者端末 → MFA verify (method "onsite")           mfa-challenge.ts の一回消費でセッション発行
 *
 * attestation を受理しても ticket は消費しない。 顔画像・テンプレート・スコアは扱わない。
 */

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users } from "../db/schema.js";
import { AppError } from "../error.js";
import { logAuthEvent } from "../logging/auth-logger.js";
import { limitMfa, readMfaTicketByDigest, readOnsiteMfaTicket, remainingMfaSeconds, MFA_TTL_SECONDS } from "./mfa-records.js";
import { checkOnsiteAttestation, onsiteAttestationError, type OnsiteAttestationDeps, type OnsiteNonceLookup } from "./onsite-attestation.js";
import { onsiteChallengeStore, type OnsiteChallengeStore } from "./onsite-challenge-store.js";
import { findOnsiteKiosk, listActiveOnsiteKiosks, publicOnsiteKiosk, type OnsiteKioskPublic } from "./onsite-kiosk-registry.js";

export interface OnsiteStartResult { nonce: string; expiresAt: string; kiosks: OnsiteKioskPublic[] }

export async function startOnsiteChallenge(mfaToken: string, store = onsiteChallengeStore): Promise<OnsiteStartResult> {
  const ticket = await readOnsiteMfaTicket(mfaToken);
  await limitMfa(`onsite-start:${ticket.digest}`, 10, MFA_TTL_SECONDS);
  const kiosks = await listActiveOnsiteKiosks(ticket.record.onsite.allowedPlaceIds);
  // Without a usable kiosk the challenge can never complete; say so instead of returning an empty wait.
  if (kiosks.length === 0) throw AppError.serviceUnavailable("No onsite kiosk is available for this service");
  const nonce = await store.issueNonce(ticket.digest, remainingMfaSeconds(ticket));
  return { nonce, expiresAt: new Date(ticket.record.expiresAt).toISOString(), kiosks: kiosks.map(publicOnsiteKiosk) };
}

async function currentMfaRevision(userId: string): Promise<number | null> {
  const rows = await db.select({ mfaRevision: users.mfaRevision }).from(users).where(eq(users.id, userId)).limit(1);
  return rows[0]?.mfaRevision ?? null;
}

function attestationDeps(store: OnsiteChallengeStore, ttl: { seconds: number }): OnsiteAttestationDeps {
  return {
    findKiosk: findOnsiteKiosk,
    currentMfaRevision,
    now: () => Date.now(),
    async lookupNonce(nonce): Promise<OnsiteNonceLookup> {
      const bound = await store.lookupNonce(nonce);
      if (bound.state !== "active") return bound;
      const ticket = await readMfaTicketByDigest(bound.ticketDigest);
      if (!ticket) return { state: "unknown" };
      ttl.seconds = remainingMfaSeconds(ticket);
      return { state: "active", ticketDigest: ticket.digest, userId: ticket.record.userId,
        mfaRevision: ticket.record.mfaRevision, requirement: ticket.record.onsite ?? null };
    },
  };
}

export async function submitOnsiteAttestation(attestation: unknown, submitter: string,
  store = onsiteChallengeStore): Promise<{ accepted: true }> {
  const ttl = { seconds: 0 };
  let accepted;
  try {
    accepted = await checkOnsiteAttestation(attestation, attestationDeps(store, ttl));
  } catch (error) {
    logAuthEvent({ event: "user.mfa.onsite.rejected", provider: "onsite", submitter,
      error: error instanceof AppError ? error.code ?? error.message : "internal" });
    throw error;
  }
  const committed = await store.commit(accepted.nonce, accepted.ticketDigest, JSON.stringify(accepted.satisfaction), ttl.seconds);
  if (committed === "used") throw onsiteAttestationError("nonce_used");
  if (committed === "unknown") throw onsiteAttestationError("nonce_unknown");
  const { satisfaction } = accepted;
  logAuthEvent({ event: "user.mfa.onsite.accepted", userId: satisfaction.userId, provider: "onsite", submitter,
    method: satisfaction.method, assurance: satisfaction.assurance, placeId: satisfaction.placeId, lanId: satisfaction.lanId });
  return { accepted: true };
}
