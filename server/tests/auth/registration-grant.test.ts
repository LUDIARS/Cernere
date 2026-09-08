import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const rows: unknown[][] = [];
  const select = vi.fn(() => {
    const query = {
      from: () => query, where: () => query,
      limit: async () => rows.shift() ?? [],
      for: async () => rows.shift() ?? [],
      then: (resolve: (value: unknown[]) => void) => resolve(rows.shift() ?? []),
    };
    return query;
  });
  const update = vi.fn(() => ({ set: () => ({ where: async () => [] }) }));
  const remove = vi.fn(() => ({ where: async () => [] }));
  const insert = vi.fn(() => ({ values: async () => [] }));
  const transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn({ select, update, delete: remove, insert }));
  return { rows, select, update, remove, insert, transaction };
});
vi.mock("../../src/db/connection.js", () => ({
  db: { select: mocks.select, transaction: mocks.transaction },
}));
import { completeRecovery, hashGrantToken, issueRecoveryGrant } from "../../src/auth/registration-grant.js";

const targetId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const keyId = "33333333-3333-4333-8333-333333333333";
const token = "A".repeat(43);
const now = new Date("2026-09-08T00:00:00Z");
function grant() {
  return { id: "grant", tokenHash: hashGrantToken(token), purpose: "recover_user",
    subjectUserId: targetId, createdByUserId: actorId, usedAt: null, revokedAt: null,
    expiresAt: new Date(now.getTime() + 60_000), targetAuthEpoch: 2, issuerAuthEpoch: 3, issuerMfaRevision: 4,
    revokePasskeyIds: [], revokeAllExistingPasskeys: true };
}
function queueCompletion(overrides: { target?: object; actor?: object; lockedGrant?: object } = {}) {
  const current = grant();
  mocks.rows.push([current], [{ id: targetId, authEpoch: 2, mfaRevision: 5, ...overrides.target }],
    [{ id: current.id }], [{ ...current, ...overrides.lockedGrant }],
    [{ id: actorId, role: "admin", authEpoch: 3, mfaRevision: 4, ...overrides.actor }], [{ id: keyId }]);
}
beforeEach(() => { vi.clearAllMocks(); mocks.rows.length = 0; });

describe("operator recovery authorization", () => {
  it.each([
    { usedAt: now }, { revokedAt: now }, { expiresAt: now },
    { purpose: "create_user" }, { targetAuthEpoch: null }, { issuerMfaRevision: null },
  ])("rejects an unavailable or incompatible grant before mutations: %j", async patch => {
    mocks.rows.push([{ ...grant(), ...patch }]);
    const insertPasskey = vi.fn();
    await expect(completeRecovery({ token, expectedSubjectUserId: targetId, insertPasskey, now })).rejects.toMatchObject({ statusCode: 401 });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(insertPasskey).not.toHaveBeenCalled();
  });
  it.each([
    { target: { authEpoch: 99 } }, { actor: { role: "general" } },
    { actor: { authEpoch: 99 } }, { actor: { mfaRevision: 99 } },
    { lockedGrant: { usedAt: now } },
  ])("rechecks target, issuer and single-use state under the lock: %j", async patch => {
    queueCompletion(patch);
    const insertPasskey = vi.fn();
    await expect(completeRecovery({ token, expectedSubjectUserId: targetId, insertPasskey, now })).rejects.toMatchObject({ statusCode: 401 });
    expect(insertPasskey).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("rejects a ceremony for a different subject", async () => {
    queueCompletion();
    const insertPasskey = vi.fn();
    await expect(completeRecovery({ token, expectedSubjectUserId: actorId, insertPasskey, now })).rejects.toMatchObject({ statusCode: 401 });
    expect(insertPasskey).not.toHaveBeenCalled();
  });
  it("rejects conflicting revocation scope from storage", async () => {
    queueCompletion({ lockedGrant: { revokePasskeyIds: [keyId], revokeAllExistingPasskeys: true } });
    await expect(completeRecovery({ token, expectedSubjectUserId: targetId, insertPasskey: vi.fn(), now })).rejects.toMatchObject({ statusCode: 401 });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("enrolls the verified key for the fixed subject inside the transaction", async () => {
    queueCompletion();
    const insertPasskey = vi.fn(async () => {});
    await completeRecovery({ token, expectedSubjectUserId: targetId, insertPasskey, now });
    expect(insertPasskey).toHaveBeenCalledWith(expect.objectContaining({ select: mocks.select }), targetId);
    expect(mocks.remove).toHaveBeenCalledOnce();
    // PostgreSQL rollback and simultaneous completion are covered by the review integration matrix.
  });
  it("does not accept an ambiguous scope at issuance", async () => {
    await expect(issueRecoveryGrant({ subjectUserId: targetId, createdByUserId: actorId })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("never persists the presented recovery token as its digest", () => {
    expect(hashGrantToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashGrantToken(token)).not.toContain(token);
  });
});
