import { describe, expect, it, vi } from "vitest";
vi.mock("../../src/redis.js", () => ({ redis: {} }));
import { ActionProofStore } from "../../src/auth/action-proof.js";
import { CompositeUploadStore } from "../../src/auth/composite-upload-store.js";
import type { UploadArrival, UploadTarget } from "../../src/auth/composite-upload-record.js";
import { MAX_UPLOAD_BYTES } from "../../src/project/service-operation-policy.js";

function fixture() {
  let now = Date.now(), entropy = 1, failReservation = false;
  const values = new Map<string, { value: string; expiresAt: number }>();
  const redis = {
    set: async (key: string, value: string, _mode: "EX", ttl: number, condition?: "NX") => {
      if (failReservation && key.startsWith("composite-upload-reservation:")) throw new Error("offline");
      if (condition === "NX" && (values.get(key)?.expiresAt ?? 0) > now) return null;
      values.set(key, { value, expiresAt: now + ttl * 1000 }); return "OK";
    },
    get: async (key: string) => { const entry = values.get(key); return entry && entry.expiresAt > now ? entry.value : null; },
    getdel: async (key: string) => { const entry = values.get(key); values.delete(key); return entry && entry.expiresAt > now ? entry.value : null; },
  };
  const proofs = new ActionProofStore({ redisClient: redis, randomBytes: () => Buffer.alloc(32, entropy++), now: () => new Date(now), ttlSeconds: 30 });
  const store = new CompositeUploadStore(redis, proofs, () => now);
  const target: UploadTarget = { projectKey: "volputas", audience: "https://vo.example", credentialGeneration: 3, requestBinding: "r".repeat(43) };
  const arrival: UploadArrival = { version: 1, byteLength: MAX_UPLOAD_BYTES, limits: { maximumBytes: MAX_UPLOAD_BYTES, timeoutSeconds: 300 },
    delegation: { version: 1,
      source: { projectKey: "glab", audience: "https://glab.example", credentialGeneration: 2, grantId: "11111111-1111-4111-8111-111111111111",
        sessionBinding: "s".repeat(43), userId: "account", subjectId: "subject", expiresAt: now + 900_000 },
      target: { projectKey: target.projectKey, audience: target.audience, credentialGeneration: target.credentialGeneration, consentRevision: "revision-1" },
      operation: { action: "evidence.media.write", method: "PUT", path: "/api/media/1", resource: "/api/media/1", contentDigest: "d".repeat(43),
        headersDigest: "h".repeat(43), requestId: "22222222-2222-4222-8222-222222222222" }, risk: "important", issuedAt: now, expiresAt: now + 30_000 } };
  return { store, arrival, target, values, advance: (ms: number) => { now += ms; }, offlineReservation: () => { failReservation = true; } };
}

describe("bounded upload reservation storage", () => {
  it("reserves a 200 MiB transfer before capability expiry and permits one bounded finalization after 30 seconds", async () => {
    const f = fixture(), token = await f.store.issue(f.arrival);
    const { receipt, reservation } = await f.store.begin(token, await f.store.readArrival(token), f.target, f.arrival.limits);
    expect(receipt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(reservation.arrival).toEqual(f.arrival);
    expect(reservation.deadline - reservation.begunAt).toBe(300_000);
    f.advance(40_000);
    await expect(f.store.readArrival(token)).rejects.toThrow();
    expect(await f.store.consume(receipt, f.target)).toEqual(reservation);
    await expect(f.store.consume(receipt, f.target)).rejects.toThrow();
  });
  it("allows only one competing begin and only one competing finalize", async () => {
    const f = fixture(), token = await f.store.issue(f.arrival);
    const begins = await Promise.allSettled([f.store.begin(token, f.arrival, f.target, f.arrival.limits), f.store.begin(token, f.arrival, f.target, f.arrival.limits)]);
    const accepted = begins.filter(result => result.status === "fulfilled"); expect(accepted).toHaveLength(1);
    const winner = accepted[0]!; if (winner.status !== "fulfilled") throw new Error("Missing reservation");
    const finalized = await Promise.allSettled([f.store.consume(winner.value.receipt, f.target), f.store.consume(winner.value.receipt, f.target)]);
    expect(finalized.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });
  it.each(["projectKey", "audience", "credentialGeneration", "requestBinding"] as const)("burns a receipt with a mismatched %s", async field => {
    const f = fixture(), token = await f.store.issue(f.arrival);
    const { receipt } = await f.store.begin(token, f.arrival, f.target, f.arrival.limits);
    const target = { ...f.target, [field]: field === "credentialGeneration" ? 4 : "x".repeat(43) } as UploadTarget;
    await expect(f.store.consume(receipt, target)).rejects.toThrow();
    await expect(f.store.consume(receipt, f.target)).rejects.toThrow();
  });
  it("uses the stricter route deadline and never extends the source grant lifetime", async () => {
    const f = fixture(); f.arrival.byteLength = 128;
    f.arrival.delegation.source.expiresAt = f.arrival.delegation.issuedAt + 10_000;
    f.arrival.delegation.expiresAt = f.arrival.delegation.source.expiresAt;
    const token = await f.store.issue(f.arrival);
    const { receipt, reservation } = await f.store.begin(token, f.arrival, f.target, { maximumBytes: 256, timeoutSeconds: 100 });
    expect(reservation.limits.maximumBytes).toBe(256);
    expect(reservation.deadline).toBe(f.arrival.delegation.source.expiresAt);
    f.advance(10_001); await expect(f.store.consume(receipt, f.target)).rejects.toThrow();
  });
  it("refuses an over-limit, unclassified-risk, future or expired arrival", async () => {
    const f = fixture();
    await expect(f.store.issue({ ...f.arrival, byteLength: MAX_UPLOAD_BYTES + 1 })).rejects.toThrow();
    await expect(f.store.issue({ ...f.arrival, delegation: { ...f.arrival.delegation, risk: "read" } })).rejects.toThrow();
    await expect(f.store.issue({ ...f.arrival, delegation: { ...f.arrival.delegation, issuedAt: f.arrival.delegation.issuedAt + 1 } })).rejects.toThrow();
    const token = await f.store.issue(f.arrival); f.advance(30_000);
    await expect(f.store.begin(token, f.arrival, f.target, f.arrival.limits)).rejects.toThrow();
  });
  it("rejects a changed body digest even before the single-use arrival is reserved", async () => {
    const f = fixture(), token = await f.store.issue(f.arrival);
    const changed = { ...f.arrival, delegation: { ...f.arrival.delegation, operation: { ...f.arrival.delegation.operation, contentDigest: "x".repeat(43) } } };
    await expect(f.store.begin(token, changed, f.target, f.arrival.limits)).rejects.toThrow();
    await expect(f.store.begin(token, f.arrival, f.target, f.arrival.limits)).rejects.toThrow();
  });
  it("does not retry a reservation write failure after irreversible arrival consumption", async () => {
    const f = fixture(), token = await f.store.issue(f.arrival); f.offlineReservation();
    await expect(f.store.begin(token, f.arrival, f.target, f.arrival.limits)).rejects.toThrow("offline");
    await expect(f.store.begin(token, f.arrival, f.target, f.arrival.limits)).rejects.toThrow();
  });
  it("cancellation burns the receipt without authorizing a final execution", async () => {
    const f = fixture(), token = await f.store.issue(f.arrival);
    const { receipt } = await f.store.begin(token, f.arrival, f.target, f.arrival.limits);
    await f.store.cancel(receipt, f.target);
    await expect(f.store.consume(receipt, f.target)).rejects.toThrow();
  });
});
