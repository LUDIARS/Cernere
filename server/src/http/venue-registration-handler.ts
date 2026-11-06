/**
 * 会場ネットワーク限定の新規登録の HTTP ハンドラ (spec/feature/venue-network-registration.md §6)。
 *
 *   POST /api/auth/venue-registration/start         未認証 (レート制限)  → { challengeId, nonce, expiresAt, kiosks }
 *   POST /api/auth/venue-registration/attestations  Os project token + venue-registration:submit → { accepted: true }
 *   GET  /api/auth/venue-registration/status        未認証 ?challengeId=  → { state }
 *
 * scope `venue-registration:submit` は呼出元 project の service_scopes 宣言 (管理者所有) で決まる。
 * @implements SPEC-VENUE-REGISTRATION
 */

import { z } from "zod";
import { onsiteAttestationError } from "../auth/onsite-attestation.js";
import { startVenueRegistration, submitVenueAttestation, venueRegistrationStatus } from "../auth/venue-registration.js";
import { requireProjectServiceScope } from "./project-service-scope-auth.js";

export const VENUE_REGISTRATION_SUBMIT_SCOPE = "venue-registration:submit";

const attestationBodySchema = z.object({ attestation: z.string() }).strict();

export type VenueRegistrationAction = "start" | "attestations" | "status";

export interface VenueRegistrationRequest {
  authHeader: string;
  body: unknown;
  query: URLSearchParams;
  ip: string | undefined;
}

export async function handleVenueRegistration(action: VenueRegistrationAction, request: VenueRegistrationRequest): Promise<unknown> {
  switch (action) {
    case "start":
      return startVenueRegistration(request.ip);
    case "attestations": {
      const principal = await requireProjectServiceScope(request.authHeader, VENUE_REGISTRATION_SUBMIT_SCOPE);
      const parsed = attestationBodySchema.safeParse(request.body);
      if (!parsed.success) throw onsiteAttestationError("invalid_format");
      return submitVenueAttestation(parsed.data.attestation, principal.projectKey);
    }
    case "status":
      return venueRegistrationStatus(request.query.get("challengeId") ?? undefined);
  }
}
