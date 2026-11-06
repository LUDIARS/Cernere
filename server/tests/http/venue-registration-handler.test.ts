/** 会場登録の 3 API: start は kiosk 無しで 503、attestation は venue-registration:submit 必須、status は場所を返さない。 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  kiosks: [] as unknown[],
  challenge: null as unknown,
  declared: [] as string[],
}));
vi.mock("../../src/redis.js", () => ({ checkRateLimit: async () => undefined, redis: {} }));
vi.mock("../../src/db/connection.js", () => ({ db: {} }));
vi.mock("../../src/auth/onsite-kiosk-registry.js", () => ({
  listActiveOnsiteKiosks: async () => state.kiosks,
  findOnsiteKiosk: async () => null,
  publicOnsiteKiosk: (row: { lanId: string; placeId: string; lanUrl: string; label: string | null }) =>
    ({ lanId: row.lanId, placeId: row.placeId, lanUrl: row.lanUrl, label: row.label }),
}));
vi.mock("../../src/auth/venue-challenge-store.js", () => ({
  issueVenueChallenge: async (now: Date) => ({ challengeId: "c-1", nonce: "n-1", expiresAt: new Date(now.getTime() + 300_000) }),
  lookupVenueNonce: async () => ({ state: "unknown" }),
  markVenueChallengeVerified: async () => "verified",
  readVenueChallenge: async () => state.challenge,
}));
vi.mock("../../src/http/project-service-scope-auth.js", async () => {
  const { AppError } = await import("../../src/error.js");
  return {
    requireProjectServiceScope: async (_auth: string, scope: string) => {
      if (!state.declared.includes(scope)) throw AppError.forbidden(`Scope ${scope} is required`);
      return { projectKey: "Ostiarius", clientId: "client-ostiarius" };
    },
  };
});

const { handleVenueRegistration, VENUE_REGISTRATION_SUBMIT_SCOPE } = await import("../../src/http/venue-registration-handler.js");

const request = (overrides: Partial<{ body: unknown; query: URLSearchParams }> = {}) =>
  ({ authHeader: "Bearer x", body: {}, query: new URLSearchParams(), ip: "192.0.2.1", ...overrides });

beforeEach(() => { state.kiosks = []; state.challenge = null; state.declared = []; });

describe("handleVenueRegistration", () => {
  it("start: returns 503 when no active kiosk exists", async () => {
    await expect(handleVenueRegistration("start", request())).rejects.toMatchObject({ statusCode: 503 });
  });

  it("start: returns the challenge, the nonce and the public kiosk data (no public keys)", async () => {
    state.kiosks = [{ lanId: "lan-1", placeId: "p", lanUrl: "https://kiosk.lan:8443", label: "受付", publicKeyPem: "secret-ish" }];
    const result = await handleVenueRegistration("start", request()) as Record<string, unknown>;
    expect(result).toMatchObject({ challengeId: "c-1", nonce: "n-1", kiosks: [{ lanId: "lan-1", placeId: "p", lanUrl: "https://kiosk.lan:8443", label: "受付" }] });
    expect(JSON.stringify(result)).not.toContain("secret-ish");
  });

  it("attestations: requires the declared venue-registration:submit scope (onsite-mfa:submit is not enough)", async () => {
    state.declared = ["onsite-mfa:submit"];
    await expect(handleVenueRegistration("attestations", request({ body: { attestation: "a.b" } }))).rejects.toMatchObject({ statusCode: 403 });
    expect(VENUE_REGISTRATION_SUBMIT_SCOPE).toBe("venue-registration:submit");
  });

  it("attestations: rejects a malformed body as invalid_format after authorization", async () => {
    state.declared = [VENUE_REGISTRATION_SUBMIT_SCOPE];
    await expect(handleVenueRegistration("attestations", request({ body: { attestation: 1 } }))).rejects.toMatchObject({ code: "invalid_format" });
  });

  it("status: returns only the state", async () => {
    state.challenge = { id: "33333333-3333-4333-8333-333333333333", expiresAt: new Date(Date.now() + 60_000),
      verifiedAt: new Date(), placeId: "11111111-1111-4111-8111-111111111111", consumedAt: null };
    const query = new URLSearchParams({ challengeId: "33333333-3333-4333-8333-333333333333" });
    await expect(handleVenueRegistration("status", request({ query }))).resolves.toEqual({ state: "verified" });
  });

  it("status: requires a challengeId", async () => {
    await expect(handleVenueRegistration("status", request())).rejects.toMatchObject({ statusCode: 400 });
  });
});
