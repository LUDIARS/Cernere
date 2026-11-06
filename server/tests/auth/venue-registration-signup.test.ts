/** signup の venueChallengeId 分岐 (§6): 会場は active + 組織 member、会場外は pending、無効は 422 で何も作らない。 */

import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ row: null as unknown, consumedPlace: null as string | null }));
vi.mock("../../src/auth/venue-challenge-store.js", () => ({
  readVenueChallenge: async () => store.row,
  consumeVenueChallenge: async () => store.consumedPlace,
}));
vi.mock("../../src/db/connection.js", () => ({ db: {} }));

const schema = await import("../../src/db/schema.js");
const { applyVenueSignup, precheckVenueSignup, VENUE_CHALLENGE_INVALID } = await import("../../src/auth/venue-registration-signup.js");

const NOW = new Date("2026-11-06T03:00:00.000Z");
const USER = "55555555-5555-4555-8555-555555555555";
const ID = "33333333-3333-4333-8333-333333333333";
const ORG = "11111111-1111-4111-8111-111111111111";

/** update(...).set(v).where(...) と insert(t).values(v)[.onConflictDoNothing()] を記録する。 */
function recordingTx() {
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const tx = {
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({ where: async () => { updates.push({ table, values }); } }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        const done = Promise.resolve();
        return Object.assign(done, { onConflictDoNothing: async () => undefined });
      },
    }),
  };
  return { tx: tx as never, updates, inserts };
}

describe("precheckVenueSignup", () => {
  it("lets a signup without a venue check through as outside_venue", async () => {
    await expect(precheckVenueSignup(undefined, NOW)).resolves.toEqual({ kind: "outside_venue" });
  });

  it("rejects an unverified challenge with 422 venue_challenge_invalid before the passkey ceremony is spent", async () => {
    store.row = { id: ID, expiresAt: new Date(NOW.getTime() + 60_000), verifiedAt: null, placeId: null, consumedAt: null };
    await expect(precheckVenueSignup(ID, NOW)).rejects.toMatchObject({ statusCode: 422, code: VENUE_CHALLENGE_INVALID });
  });

  it("accepts a verified challenge", async () => {
    store.row = { id: ID, expiresAt: new Date(NOW.getTime() + 60_000), verifiedAt: NOW, placeId: ORG, consumedAt: null };
    await expect(precheckVenueSignup(ID, NOW)).resolves.toEqual({ kind: "venue", challengeId: ID, placeId: ORG });
  });
});

describe("applyVenueSignup", () => {
  it("marks an outside-venue registration and leaves it pending without an organization", async () => {
    const { tx, updates, inserts } = recordingTx();
    await expect(applyVenueSignup(tx, USER, { kind: "outside_venue" }, NOW)).resolves.toEqual({ origin: "outside_venue", placeId: null });
    expect(updates).toEqual([{ table: schema.users, values: { registrationOrigin: "outside_venue" } }]);
    expect(inserts).toEqual([]);
  });

  it("activates a venue registration, joins the kiosk's organization as member and audits the automatic approval", async () => {
    store.consumedPlace = ORG;
    const { tx, updates, inserts } = recordingTx();
    await expect(applyVenueSignup(tx, USER, { kind: "venue", challengeId: ID, placeId: ORG }, NOW))
      .resolves.toEqual({ origin: "venue", placeId: ORG });
    expect(updates[0]).toEqual({ table: schema.users, values: {
      registrationOrigin: "venue", registrationPlaceId: ORG, accessStatus: "active", accessRevision: 1, accessChangedAt: NOW,
    } });
    expect(inserts[0]).toEqual({ table: schema.organizationMembers, values: { organizationId: ORG, userId: USER, role: "member", joinedAt: NOW } });
    expect(inserts[1]).toMatchObject({ table: schema.accessDecisions, values: {
      actorUserId: null, targetUserId: USER, beforeStatus: "pending", afterStatus: "active", reasonCode: "venue_registration",
    } });
  });

  it("aborts with 422 when another signup consumed the challenge first (one venue check admits one account)", async () => {
    store.consumedPlace = null;
    const { tx, updates, inserts } = recordingTx();
    await expect(applyVenueSignup(tx, USER, { kind: "venue", challengeId: ID, placeId: ORG }, NOW))
      .rejects.toMatchObject({ statusCode: 422, code: VENUE_CHALLENGE_INVALID });
    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });
});
