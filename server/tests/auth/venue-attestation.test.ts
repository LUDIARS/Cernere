/** 会場ネットワーク限定の新規登録: purpose:"registration" attestation の §3 検証 1〜7。 @implements SPEC-VENUE-REGISTRATION */

import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { checkVenueAttestation, isOrganizationPlaceId, type VenueAttestationDeps,
  type VenueNonceLookup } from "../../src/auth/venue-attestation.js";
import type { OnsiteKioskKey } from "../../src/auth/onsite-attestation.js";

const NOW = Date.parse("2026-11-06T03:00:00.000Z");
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const CHALLENGE = "33333333-3333-4333-8333-333333333333";

function keyPair(): { privateKey: KeyObject; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

const kioskKeys = keyPair();
const otherKeys = keyPair();

/** Ostiarius の署名と同じ固定順 (sub, placeId, lanId, nonce, issuedAt, method, assurance, purpose)。 */
function attest(overrides: Record<string, unknown> = {}, privateKey = kioskKeys.privateKey): string {
  const payload = { sub: null, placeId: ORG, lanId: "lan-1", nonce: "nonce-1", issuedAt: NOW - 1_000,
    method: "lan", assurance: "network", purpose: "registration", ...overrides };
  for (const [key, value] of Object.entries(payload)) if (value === undefined) delete (payload as Record<string, unknown>)[key];
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`;
}

function deps(options: { kiosk?: OnsiteKioskKey | null; nonce?: VenueNonceLookup; organization?: boolean } = {}) {
  const kiosk = options.kiosk === undefined
    ? { lanId: "lan-1", placeId: ORG, publicKeyPem: kioskKeys.publicKeyPem, status: "active" }
    : options.kiosk;
  const lookupNonce = vi.fn(async () => options.nonce ?? { state: "active" as const, challengeId: CHALLENGE });
  const organizationExists = vi.fn(async () => options.organization ?? true);
  const value: VenueAttestationDeps = { findKiosk: async () => kiosk, lookupNonce, organizationExists, now: () => NOW };
  return { value, lookupNonce, organizationExists };
}

describe("checkVenueAttestation", () => {
  it("accepts a fresh network attestation and takes the organization from the registered kiosk", async () => {
    await expect(checkVenueAttestation(attest(), deps().value)).resolves.toEqual({
      challengeId: CHALLENGE, nonce: "nonce-1", lanId: "lan-1", placeId: ORG, issuedAt: NOW - 1_000, acceptedAt: NOW,
    });
  });

  it("rejects malformed input as invalid_format", async () => {
    await expect(checkVenueAttestation("a.b.c", deps().value)).rejects.toMatchObject({ code: "invalid_format", statusCode: 400 });
    await expect(checkVenueAttestation(attest({ orgId: ORG }), deps().value)).rejects.toMatchObject({ code: "invalid_format" });
  });

  it("1: rejects an unknown kiosk, a revoked kiosk and a wrong signature without reading the challenge", async () => {
    const unknown = deps({ kiosk: null });
    await expect(checkVenueAttestation(attest(), unknown.value)).rejects.toMatchObject({ code: "unknown_kiosk", statusCode: 401 });
    expect(unknown.lookupNonce).not.toHaveBeenCalled();
    const revoked = deps({ kiosk: { lanId: "lan-1", placeId: ORG, publicKeyPem: kioskKeys.publicKeyPem, status: "revoked" } });
    await expect(checkVenueAttestation(attest(), revoked.value)).rejects.toMatchObject({ code: "revoked_kiosk" });
    const forged = deps();
    await expect(checkVenueAttestation(attest({}, otherKeys.privateKey), forged.value)).rejects.toMatchObject({ code: "invalid_signature" });
    expect(forged.lookupNonce).not.toHaveBeenCalled();
  });

  it.each([["mfa"], ["attendance"], [undefined]])("2: rejects a %s attestation as purpose_mismatch", async (purpose) => {
    await expect(checkVenueAttestation(attest({ purpose }), deps().value)).rejects.toMatchObject({ code: "purpose_mismatch", statusCode: 403 });
  });

  it("3: rejects an unknown or used nonce and an attestation that names a subject", async () => {
    await expect(checkVenueAttestation(attest(), deps({ nonce: { state: "unknown" } }).value)).rejects.toMatchObject({ code: "nonce_unknown", statusCode: 404 });
    await expect(checkVenueAttestation(attest(), deps({ nonce: { state: "used" } }).value)).rejects.toMatchObject({ code: "nonce_used", statusCode: 409 });
    await expect(checkVenueAttestation(attest({ sub: "user-1" }), deps().value)).rejects.toMatchObject({ code: "subject_mismatch" });
  });

  it("4: rejects an attestation older or newer than 120 seconds", async () => {
    await expect(checkVenueAttestation(attest({ issuedAt: NOW - 120_001 }), deps().value)).rejects.toMatchObject({ code: "stale" });
    await expect(checkVenueAttestation(attest({ issuedAt: NOW + 120_001 }), deps().value)).rejects.toMatchObject({ code: "stale" });
  });

  it("5: accepts only method lan with assurance network", async () => {
    await expect(checkVenueAttestation(attest({ method: "face", assurance: "high" }), deps().value)).rejects.toMatchObject({ code: "assurance_insufficient" });
    await expect(checkVenueAttestation(attest({ assurance: "low" }), deps().value)).rejects.toMatchObject({ code: "assurance_insufficient" });
  });

  it("6: rejects a placeId other than the kiosk's registered place (Os cannot name another organization)", async () => {
    await expect(checkVenueAttestation(attest({ placeId: OTHER_ORG }), deps().value)).rejects.toMatchObject({ code: "place_not_allowed" });
  });

  it("7: rejects a kiosk whose place is not an organization", async () => {
    await expect(checkVenueAttestation(attest(), deps({ organization: false }).value)).rejects.toMatchObject({ code: "organization_unknown", statusCode: 403 });
    const legacy = deps({ kiosk: { lanId: "lan-1", placeId: "glab-main", publicKeyPem: kioskKeys.publicKeyPem, status: "active" } });
    await expect(checkVenueAttestation(attest({ placeId: "glab-main" }), legacy.value)).rejects.toMatchObject({ code: "organization_unknown" });
    expect(legacy.organizationExists).not.toHaveBeenCalled();
  });
});

describe("isOrganizationPlaceId", () => {
  it("accepts organization UUIDs only", () => {
    expect(isOrganizationPlaceId(ORG)).toBe(true);
    expect(isOrganizationPlaceId("glab-main")).toBe(false);
  });
});
