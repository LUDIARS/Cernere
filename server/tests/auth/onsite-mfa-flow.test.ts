/**
 * onsite challenge の start → kiosk attestation → MFA verify の流れ。
 * ticket 未充足の 409 onsite_pending、 並行 verify の一回消費、 nonce の再送拒否を確かめる。
 * @implements SPEC-MFA-ONSITE
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  redis: null as unknown as import("./fake-mfa-redis.js").FakeMfaRedis,
  user: null as unknown as Record<string, unknown>,
  kioskStatus: "active",
}));

vi.mock("../../src/redis.js", async () => {
  const { FakeMfaRedis } = await import("./fake-mfa-redis.js");
  hoisted.redis = new FakeMfaRedis();
  return { redis: new Proxy({}, { get: (_t, key) => (hoisted.redis as unknown as Record<string | symbol, unknown>)[key] }) };
});
vi.mock("../../src/db/connection.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ mfaRevision: hoisted.user.mfaRevision }] }) }) }),
  },
}));
vi.mock("../../src/auth/mfa-user.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/auth/mfa-user.js")>();
  return {
    ...original,
    loadMfaUser: async () => hoisted.user,
    withMfaUser: async (_id: string, action: (user: unknown, tx: unknown) => Promise<unknown>) => action(hoisted.user, {}),
  };
});

const kioskKeys = generateKeyPairSync("ed25519");
const PUBLIC_PEM = kioskKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
vi.mock("../../src/auth/onsite-kiosk-registry.js", () => {
  const kiosk = () => ({ lanId: "lan-1", placeId: "place-1", publicKeyPem: PUBLIC_PEM, lanUrl: "https://kiosk.lan",
    label: "1F", status: hoisted.kioskStatus });
  return {
    findOnsiteKiosk: async (lanId: string) => (lanId === "lan-1" ? kiosk() : null),
    listActiveOnsiteKiosks: async () => (hoisted.kioskStatus === "active" ? [kiosk()] : []),
    publicOnsiteKiosk: (row: { lanId: string; placeId: string; lanUrl: string; label: string | null }) =>
      ({ lanId: row.lanId, placeId: row.placeId, lanUrl: row.lanUrl, label: row.label }),
  };
});

const { beginMfaChallenge, verifyMfaChallenge } = await import("../../src/auth/mfa-challenge.js");
const { startOnsiteChallenge, submitOnsiteAttestation } = await import("../../src/auth/onsite-challenge.js");

const USER_ID = "33333333-3333-4333-8333-333333333333";
const CONTEXT = { purpose: "composite" as const, projectKey: "Schedula" };

function attest(nonce: string, overrides: Record<string, unknown> = {}): string {
  const payload = { sub: USER_ID, placeId: "place-1", lanId: "lan-1", nonce, issuedAt: Date.now(),
    method: "face", assurance: "high", purpose: "mfa", ...overrides };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(null, Buffer.from(body), kioskKeys.privateKey).toString("base64url")}`;
}

async function onsiteChallenge(minAssurance: "high" | "medium" = "high") {
  const challenge = await beginMfaChallenge(hoisted.user as never, CONTEXT, { minAssurance, allowedPlaceIds: null });
  const started = await startOnsiteChallenge(challenge.mfaToken);
  return { ...challenge, ...started };
}

const complete = async () => "session-issued";

beforeEach(() => {
  hoisted.redis.store.clear();
  hoisted.kioskStatus = "active";
  hoisted.user = { id: USER_ID, passwordHash: "hash", email: "u@example.com", mfaEnabled: false, mfaMethods: [],
    totpEnabled: false, totpSecret: null, mfaRevision: 4 };
});

describe("onsite MFA flow", () => {
  it("requires onsite even when the user has no MFA enrolled, and offers only onsite", async () => {
    const challenge = await onsiteChallenge();
    expect(challenge.mfaMethods).toEqual(["onsite"]);
    expect(challenge.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge.kiosks).toEqual([{ lanId: "lan-1", placeId: "place-1", lanUrl: "https://kiosk.lan", label: "1F" }]);
    expect(Date.parse(challenge.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("answers 409 onsite_pending until a kiosk attestation is accepted", async () => {
    const challenge = await onsiteChallenge();
    await expect(verifyMfaChallenge(challenge.mfaToken, "onsite", "", CONTEXT, complete))
      .rejects.toMatchObject({ statusCode: 409, code: "onsite_pending" });
    await expect(submitOnsiteAttestation(attest(challenge.nonce), "ostiarius")).resolves.toEqual({ accepted: true });
    await expect(verifyMfaChallenge(challenge.mfaToken, "onsite", "", CONTEXT, complete)).resolves.toBe("session-issued");
  });

  it("does not consume the ticket on acceptance, and rejects a replayed attestation as nonce_used", async () => {
    const challenge = await onsiteChallenge();
    const token = attest(challenge.nonce);
    await submitOnsiteAttestation(token, "ostiarius");
    await expect(submitOnsiteAttestation(token, "ostiarius")).rejects.toMatchObject({ code: "nonce_used" });
    await expect(verifyMfaChallenge(challenge.mfaToken, "onsite", "", CONTEXT, complete)).resolves.toBe("session-issued");
  });

  it("issues exactly one session for concurrent verify requests", async () => {
    const challenge = await onsiteChallenge();
    await submitOnsiteAttestation(attest(challenge.nonce), "ostiarius");
    const results = await Promise.allSettled([
      verifyMfaChallenge(challenge.mfaToken, "onsite", "", CONTEXT, complete),
      verifyMfaChallenge(challenge.mfaToken, "onsite", "", CONTEXT, complete),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("does not let an onsite ticket be satisfied by another factor", async () => {
    const challenge = await onsiteChallenge();
    await expect(verifyMfaChallenge(challenge.mfaToken, "totp", "123456", CONTEXT, complete))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  it("accepts a kiosk passkey (medium) only for a medium requirement", async () => {
    const medium = await onsiteChallenge("medium");
    await expect(submitOnsiteAttestation(attest(medium.nonce, { method: "passkey", assurance: "medium" }), "ostiarius"))
      .resolves.toEqual({ accepted: true });
    const high = await onsiteChallenge("high");
    await expect(submitOnsiteAttestation(attest(high.nonce, { method: "passkey", assurance: "medium" }), "ostiarius"))
      .rejects.toMatchObject({ code: "assurance_insufficient" });
  });

  it("rejects attestations signed by a revoked kiosk", async () => {
    const challenge = await onsiteChallenge();
    hoisted.kioskStatus = "revoked";
    await expect(submitOnsiteAttestation(attest(challenge.nonce), "ostiarius")).rejects.toMatchObject({ code: "revoked_kiosk" });
  });

  it("rejects an attestation for a challenge whose MFA settings changed", async () => {
    const challenge = await onsiteChallenge();
    hoisted.user = { ...hoisted.user, mfaRevision: 5 };
    await expect(submitOnsiteAttestation(attest(challenge.nonce), "ostiarius")).rejects.toMatchObject({ code: "mfa_revision_changed" });
  });

  it("invalidates the previous nonce when the device restarts the challenge", async () => {
    const challenge = await onsiteChallenge();
    const restarted = await startOnsiteChallenge(challenge.mfaToken);
    await expect(submitOnsiteAttestation(attest(challenge.nonce), "ostiarius")).rejects.toMatchObject({ code: "nonce_unknown" });
    await expect(submitOnsiteAttestation(attest(restarted.nonce), "ostiarius")).resolves.toEqual({ accepted: true });
  });

  it("refuses onsite start for a ticket without an onsite requirement", async () => {
    hoisted.user = { ...hoisted.user, mfaEnabled: true, mfaMethods: ["email"] };
    const plain = await beginMfaChallenge(hoisted.user as never, CONTEXT);
    expect(plain.mfaMethods).toEqual(["email"]);
    await expect(startOnsiteChallenge(plain.mfaToken)).rejects.toMatchObject({ statusCode: 400 });
    await expect(verifyMfaChallenge(plain.mfaToken, "onsite", "", CONTEXT, complete)).rejects.toMatchObject({ statusCode: 401 });
  });
});
