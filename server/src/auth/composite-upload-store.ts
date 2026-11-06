/** Arrival capability and finalization receipt are separate single-use boundaries.
 * Live user/consent/resource checks belong to the handler after atomic consume.
 * @implements SPEC-COMPOSITE-UPLOAD-RESERVATION
 */
import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../error.js";
import type { ActionProofExpectation, ActionProofStore } from "./action-proof.js";
import { uploadArrivalSchema, uploadLimitsSchema, uploadReservationSchema,
  type UploadArrival, type UploadLimits, type UploadReservation, type UploadTarget } from "./composite-upload-record.js";

interface UploadRedis {
  set(key: string, value: string, expiry: "EX", seconds: number, condition: "NX"): Promise<unknown>;
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
}
const invalid = (): AppError => AppError.forbidden("Upload authority is missing, expired or invalid");
function key(kind: "arrival" | "reservation", token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
  return `composite-upload-${kind}:${createHash("sha256").update(token, "utf8").digest("base64url")}`;
}
function expectation(arrival: UploadArrival): ActionProofExpectation {
  const { source, target } = arrival.delegation;
  return { userId: source.userId, binding: `upload:${source.projectKey}:${source.sessionBinding}:${target.projectKey}`,
    action: "service.operation", resource: createHash("sha256").update(JSON.stringify(arrival), "utf8").digest("base64url") };
}

export class CompositeUploadStore {
  constructor(private readonly redis: UploadRedis, private readonly proofs: Pick<ActionProofStore, "issue" | "consume">,
    private readonly now: () => number = () => Date.now()) {}

  async issue(arrival: UploadArrival): Promise<string> {
    const checked = this.validArrival(arrival);
    const { proof } = await this.proofs.issue(expectation(checked));
    const ttl = Math.ceil((checked.delegation.expiresAt - this.now()) / 1000);
    if (ttl < 1 || await this.redis.set(key("arrival", proof), JSON.stringify(checked), "EX", ttl, "NX") !== "OK") throw invalid();
    return proof;
  }
  async readArrival(token: string): Promise<UploadArrival> {
    const raw = await this.redis.get(key("arrival", token));
    if (!raw) throw invalid();
    try { return this.validArrival(JSON.parse(raw)); } catch { throw invalid(); }
  }
  async begin(token: string, arrival: UploadArrival, target: UploadTarget, routeLimits: UploadLimits): Promise<{ receipt: string; reservation: UploadReservation }> {
    const checked = this.validArrival(arrival);
    this.matchesTarget(checked, target);
    const parsed = uploadLimitsSchema.safeParse(routeLimits);
    if (!parsed.success) throw invalid();
    const limits = { maximumBytes: Math.min(checked.limits.maximumBytes, parsed.data.maximumBytes),
      timeoutSeconds: Math.min(checked.limits.timeoutSeconds, parsed.data.timeoutSeconds) };
    const begunAt = this.now();
    const reservation = uploadReservationSchema.safeParse({ version: 1, arrival: checked, requestBinding: target.requestBinding,
      begunAt, deadline: Math.min(checked.delegation.source.expiresAt, begunAt + limits.timeoutSeconds * 1000), limits });
    if (!reservation.success) throw invalid();
    // GETDEL of the existing proof is the atomic arrival reservation point. A
    // persistence error afterwards burns the attempt; callers never retry it.
    await this.proofs.consume(token, expectation(checked));
    const receipt = randomBytes(32).toString("base64url");
    const ttl = Math.ceil((reservation.data.deadline - this.now()) / 1000);
    if (ttl < 1 || await this.redis.set(key("reservation", receipt), JSON.stringify(reservation.data), "EX", ttl, "NX") !== "OK") throw invalid();
    return { receipt, reservation: reservation.data };
  }
  async consume(receipt: string, target: UploadTarget): Promise<UploadReservation> {
    // Consume before validation: there is no replay after wrong binding, an
    // unknown result or a later failed live authority/resource check.
    const raw = await this.redis.getdel(key("reservation", receipt));
    if (!raw) throw invalid();
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw invalid(); }
    const parsed = uploadReservationSchema.safeParse(value);
    if (!parsed.success || parsed.data.begunAt > this.now() || parsed.data.deadline <= this.now()
      || parsed.data.arrival.delegation.source.expiresAt <= this.now() || parsed.data.requestBinding !== target.requestBinding) throw invalid();
    this.matchesTarget(parsed.data.arrival, target);
    return parsed.data;
  }
  async cancel(receipt: string, target: UploadTarget): Promise<void> { await this.consume(receipt, target); }
  private validArrival(value: unknown): UploadArrival {
    const parsed = uploadArrivalSchema.safeParse(value);
    if (!parsed.success || parsed.data.delegation.issuedAt > this.now() || parsed.data.delegation.expiresAt <= this.now()
      || parsed.data.delegation.source.expiresAt <= this.now()) throw invalid();
    return parsed.data;
  }
  private matchesTarget(arrival: UploadArrival, target: UploadTarget): void {
    const expected = arrival.delegation.target;
    if (expected.projectKey !== target.projectKey || expected.audience !== target.audience
      || expected.credentialGeneration !== target.credentialGeneration || !/^[A-Za-z0-9_-]{43}$/.test(target.requestBinding)) throw invalid();
  }
}
