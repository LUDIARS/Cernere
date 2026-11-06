/** venue challenge の状態と signup の分岐 (§2 / §6)。 @implements SPEC-VENUE-REGISTRATION */

import { describe, expect, it } from "vitest";
import { venueChallengeState, venueSignupOutcome, type VenueChallengeRow } from "../../src/auth/venue-challenge-state.js";

const NOW = new Date("2026-11-06T03:00:00.000Z");
const ID = "33333333-3333-4333-8333-333333333333";
const ORG = "11111111-1111-4111-8111-111111111111";

function row(overrides: Partial<VenueChallengeRow> = {}): VenueChallengeRow {
  return { id: ID, expiresAt: new Date(NOW.getTime() + 60_000), verifiedAt: null, placeId: null, consumedAt: null, ...overrides };
}
const verified = (overrides: Partial<VenueChallengeRow> = {}) => row({ verifiedAt: NOW, placeId: ORG, ...overrides });

describe("venueChallengeState", () => {
  it("is pending until a kiosk verifies it, then verified", () => {
    expect(venueChallengeState(row(), NOW)).toBe("pending");
    expect(venueChallengeState(verified(), NOW)).toBe("verified");
  });

  it("reads expired for an unknown, expired or consumed challenge", () => {
    expect(venueChallengeState(null, NOW)).toBe("expired");
    expect(venueChallengeState(verified({ expiresAt: NOW }), NOW)).toBe("expired");
    expect(venueChallengeState(verified({ consumedAt: NOW }), NOW)).toBe("expired");
  });
});

describe("venueSignupOutcome", () => {
  it("registers outside_venue when no challenge is given", () => {
    expect(venueSignupOutcome(undefined, null, NOW)).toEqual({ kind: "outside_venue" });
  });

  it("joins the kiosk's organization for a verified, unconsumed, unexpired challenge", () => {
    expect(venueSignupOutcome(ID, verified(), NOW)).toEqual({ kind: "venue", challengeId: ID, placeId: ORG });
  });

  it.each([
    ["unknown", null],
    ["unverified", row()],
    ["expired", verified({ expiresAt: new Date(NOW.getTime() - 1) })],
    ["consumed", verified({ consumedAt: NOW })],
    ["another id", verified({ id: "44444444-4444-4444-8444-444444444444" })],
  ])("never falls back to outside_venue for a %s challenge", (_label, value) => {
    expect(venueSignupOutcome(ID, value, NOW)).toEqual({ kind: "invalid" });
  });
});
