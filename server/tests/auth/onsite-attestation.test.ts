/** 現地確認 attestation の §4.2 検証 1〜7 と assurance 判定。 @implements SPEC-MFA-ONSITE */

import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkOnsiteAttestation, type OnsiteAttestationDeps, type OnsiteKioskKey,
  type OnsiteNonceLookup } from "../../src/auth/onsite-attestation.js";
import { meetsOnsiteAssurance } from "../../src/auth/onsite-assurance.js";

const NOW = Date.parse("2026-10-04T03:00:00.000Z");
const USER = "33333333-3333-4333-8333-333333333333";
const DIGEST = "a".repeat(64);

function keyPair(): { privateKey: KeyObject; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

const kioskKeys = keyPair();
const otherKeys = keyPair();

/** Ostiarius signAttestation と同じ形式 (キー順固定、 purpose 末尾)。 */
function attest(overrides: Record<string, unknown> = {}, privateKey = kioskKeys.privateKey): string {
  const payload = { sub: USER, placeId: "place-1", lanId: "lan-1", nonce: "nonce-1", issuedAt: NOW - 1_000,
    method: "face", assurance: "high", purpose: "mfa", ...overrides };
  for (const [key, value] of Object.entries(payload)) if (value === undefined) delete (payload as Record<string, unknown>)[key];
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`;
}

function deps(options: {
  kiosk?: OnsiteKioskKey | null; nonce?: OnsiteNonceLookup; revision?: number | null;
} = {}): OnsiteAttestationDeps {
  const kiosk = options.kiosk === undefined
    ? { lanId: "lan-1", placeId: "place-1", publicKeyPem: kioskKeys.publicKeyPem, status: "active" }
    : options.kiosk;
  const nonce: OnsiteNonceLookup = options.nonce ?? { state: "active", ticketDigest: DIGEST, userId: USER, mfaRevision: 4,
    requirement: { minAssurance: "high", allowedPlaceIds: null } };
  return {
    findKiosk: async () => kiosk,
    lookupNonce: async () => nonce,
    currentMfaRevision: async () => (options.revision === undefined ? 4 : options.revision),
    now: () => NOW,
  };
}

const active = (requirement: { minAssurance: "high" | "medium"; allowedPlaceIds: string[] | null }): OnsiteNonceLookup =>
  ({ state: "active", ticketDigest: DIGEST, userId: USER, mfaRevision: 4, requirement });

describe("checkOnsiteAttestation", () => {
  it("accepts a fresh face attestation and returns only the satisfaction, never face data", async () => {
    const accepted = await checkOnsiteAttestation(attest(), deps());
    expect(accepted).toEqual({
      nonce: "nonce-1", ticketDigest: DIGEST, requirement: { minAssurance: "high", allowedPlaceIds: null },
      satisfaction: { userId: USER, method: "face", assurance: "high", placeId: "place-1", lanId: "lan-1",
        issuedAt: NOW - 1_000, acceptedAt: NOW },
    });
  });

  it.each([
    ["not a string", 42],
    ["three segments", "a.b.c"],
    ["non-JSON payload", `${Buffer.from("x").toString("base64url")}.AAAA`],
    ["unknown payload key", attest({ score: 0.99 })],
  ])("rejects malformed input (%s) as invalid_format", async (_label, token) => {
    await expect(checkOnsiteAttestation(token, deps())).rejects.toMatchObject({ code: "invalid_format", statusCode: 400 });
  });

  it("1: rejects an unregistered kiosk", async () => {
    await expect(checkOnsiteAttestation(attest(), deps({ kiosk: null }))).rejects.toMatchObject({ code: "unknown_kiosk" });
  });

  it("1: rejects a revoked kiosk key even with a valid signature", async () => {
    const revoked = { lanId: "lan-1", placeId: "place-1", publicKeyPem: kioskKeys.publicKeyPem, status: "revoked" };
    await expect(checkOnsiteAttestation(attest(), deps({ kiosk: revoked }))).rejects.toMatchObject({ code: "revoked_kiosk" });
  });

  it("1: rejects a signature from another key", async () => {
    await expect(checkOnsiteAttestation(attest({}, otherKeys.privateKey), deps()))
      .rejects.toMatchObject({ code: "invalid_signature" });
  });

  it("2: rejects attendance and legacy (purpose-less) attestations", async () => {
    await expect(checkOnsiteAttestation(attest({ purpose: "attendance" }), deps())).rejects.toMatchObject({ code: "purpose_mismatch" });
    await expect(checkOnsiteAttestation(attest({ purpose: undefined }), deps())).rejects.toMatchObject({ code: "purpose_mismatch" });
  });

  it("3: rejects an unknown and an already used nonce", async () => {
    await expect(checkOnsiteAttestation(attest(), deps({ nonce: { state: "unknown" } }))).rejects.toMatchObject({ code: "nonce_unknown" });
    await expect(checkOnsiteAttestation(attest(), deps({ nonce: { state: "used" } }))).rejects.toMatchObject({ code: "nonce_used" });
  });

  it("3: rejects a nonce bound to a ticket without an onsite requirement", async () => {
    const plain: OnsiteNonceLookup = { state: "active", ticketDigest: DIGEST, userId: USER, mfaRevision: 4, requirement: null };
    await expect(checkOnsiteAttestation(attest(), deps({ nonce: plain }))).rejects.toMatchObject({ code: "nonce_unknown" });
  });

  it("3: rejects a kiosk-identified subject that differs from the challenge user", async () => {
    await expect(checkOnsiteAttestation(attest({ sub: "44444444-4444-4444-8444-444444444444" }), deps()))
      .rejects.toMatchObject({ code: "subject_mismatch" });
  });

  it("4: rejects an attestation older than 120 seconds", async () => {
    await expect(checkOnsiteAttestation(attest({ issuedAt: NOW - 120_001 }), deps())).rejects.toMatchObject({ code: "stale" });
    await expect(checkOnsiteAttestation(attest({ issuedAt: NOW - 120_000 }), deps())).resolves.toBeDefined();
  });

  it.each([
    ["staff_override", "manual"],
    ["session", "low"],
    ["password", "low"],
  ])("5: never accepts %s (%s) as MFA", async (method, assurance) => {
    await expect(checkOnsiteAttestation(attest({ method, assurance }), deps({ nonce: active({ minAssurance: "medium", allowedPlaceIds: null }) })))
      .rejects.toMatchObject({ code: "assurance_insufficient" });
  });

  it("5: accepts passkey (medium) only when medium is required", async () => {
    const passkey = attest({ method: "passkey", assurance: "medium" });
    await expect(checkOnsiteAttestation(passkey, deps({ nonce: active({ minAssurance: "medium", allowedPlaceIds: null }) })))
      .resolves.toMatchObject({ satisfaction: { method: "passkey", assurance: "medium" } });
    await expect(checkOnsiteAttestation(passkey, deps({ nonce: active({ minAssurance: "high", allowedPlaceIds: null }) })))
      .rejects.toMatchObject({ code: "assurance_insufficient" });
  });

  it("6: rejects a place outside allowed_place_ids or different from the kiosk registration", async () => {
    await expect(checkOnsiteAttestation(attest(), deps({ nonce: active({ minAssurance: "high", allowedPlaceIds: ["place-2"] }) })))
      .rejects.toMatchObject({ code: "place_not_allowed" });
    await expect(checkOnsiteAttestation(attest({ placeId: "place-2" }), deps()))
      .rejects.toMatchObject({ code: "place_not_allowed" });
  });

  it("7: rejects when mfa_revision changed after the challenge", async () => {
    await expect(checkOnsiteAttestation(attest(), deps({ revision: 5 }))).rejects.toMatchObject({ code: "mfa_revision_changed" });
    await expect(checkOnsiteAttestation(attest(), deps({ revision: null }))).rejects.toMatchObject({ code: "mfa_revision_changed" });
  });

  it("checks in §4.2 order: a revoked kiosk wins over a wrong purpose", async () => {
    const revoked = { lanId: "lan-1", placeId: "place-1", publicKeyPem: kioskKeys.publicKeyPem, status: "revoked" };
    await expect(checkOnsiteAttestation(attest({ purpose: "attendance" }), deps({ kiosk: revoked })))
      .rejects.toMatchObject({ code: "revoked_kiosk" });
  });
});

describe("meetsOnsiteAssurance", () => {
  it("orders high above medium and never accepts manual / low", () => {
    expect(meetsOnsiteAssurance("face", "high", "high")).toBe(true);
    expect(meetsOnsiteAssurance("face_passive", "medium", "high")).toBe(false);
    expect(meetsOnsiteAssurance("face_passive", "medium", "medium")).toBe(true);
    expect(meetsOnsiteAssurance("staff_override", "high", "medium")).toBe(false);
    expect(meetsOnsiteAssurance("face", "low", "medium")).toBe(false);
    expect(meetsOnsiteAssurance(undefined, undefined, "medium")).toBe(false);
  });
});
