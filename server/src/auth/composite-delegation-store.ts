/** One-use metadata behind an existing ActionProofStore capability.
 * @implements SPEC-COMPOSITE-DELEGATION
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../error.js";
import type { ActionProofStore, ActionProofExpectation } from "./action-proof.js";

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const delegatedOperationSchema = z.object({
  action: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{1,127}$/),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1).max(4096), resource: z.string().min(1).max(4096),
  contentDigest: opaque, headersDigest: opaque, requestId: z.string().uuid(),
}).strict().superRefine((value, ctx) => {
  try {
    const url = new URL(value.path, "https://delegation.invalid");
    if (url.origin !== "https://delegation.invalid" || url.pathname + url.search !== value.path || url.hash
      || value.resource !== value.path) throw new Error("Noncanonical resource");
  } catch { ctx.addIssue({ code: "custom", message: "Delegation requires the exact canonical request path and resource" }); }
});
export type DelegatedOperation = z.infer<typeof delegatedOperationSchema>;
export function delegatedEnvelope(value: DelegatedOperation): DelegatedOperation {
  const { action, method, path, resource, contentDigest, headersDigest, requestId } = value;
  return delegatedOperationSchema.parse({ action, method, path, resource, contentDigest, headersDigest, requestId });
}
const reference = z.object({ projectKey: z.string().min(1).max(128), audience: z.string().url(), credentialGeneration: z.number().int().nonnegative() }).strict();
export const delegationRecordSchema = z.object({
  version: z.literal(1), source: reference.extend({ grantId: z.string().uuid(), sessionBinding: opaque,
    userId: z.string().min(1), subjectId: z.string().min(1), expiresAt: z.number().finite().positive() }).strict(),
  target: reference.extend({ consentRevision: z.string().min(1) }).strict(),
  operation: delegatedOperationSchema, risk: z.enum(["read", "sensitive_read", "important"]),
  issuedAt: z.number().finite().positive(), expiresAt: z.number().finite().positive(),
}).strict();
export type DelegationRecord = z.infer<typeof delegationRecordSchema>;
interface MetadataRedis {
  set(key: string, value: string, expiry: "EX", seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
}
const invalid = (): AppError => AppError.forbidden("Delegation is missing, expired or invalid");
function key(token: string): string { return `composite-delegation:${createHash("sha256").update(token).digest("base64url")}`; }
function expectation(record: DelegationRecord): ActionProofExpectation {
  return { userId: record.source.userId, binding: `delegation:${record.source.projectKey}:${record.source.sessionBinding}:${record.target.projectKey}`,
    action: "service.operation", resource: createHash("sha256").update(JSON.stringify(delegationRecordSchema.parse(record)), "utf8").digest("base64url") };
}
export class CompositeDelegationStore {
  constructor(private readonly redis: MetadataRedis, private readonly proofs: Pick<ActionProofStore, "issue" | "consume">,
    private readonly now: () => number = Date.now) {}
  async issue(record: DelegationRecord): Promise<string> {
    const checked = this.validate(record);
    const { proof } = await this.proofs.issue(expectation(checked));
    await this.redis.set(key(proof), JSON.stringify(checked), "EX", 30);
    return proof;
  }
  async read(token: string): Promise<DelegationRecord> {
    if (!opaque.safeParse(token).success) throw invalid();
    const raw = await this.redis.get(key(token));
    if (!raw) throw invalid();
    try { return this.validate(JSON.parse(raw)); } catch { throw invalid(); }
  }
  async consume(token: string, record: DelegationRecord): Promise<void> {
    // The proof GETDEL is the single atomic authorization point. Metadata remains
    // only until TTL for correlation; it cannot authorize a replay without the proof.
    await this.proofs.consume(token, expectation(this.validate(record)));
  }
  private validate(value: unknown): DelegationRecord {
    const parsed = delegationRecordSchema.safeParse(value);
    if (!parsed.success || parsed.data.issuedAt > this.now() || parsed.data.expiresAt <= this.now()
      || parsed.data.expiresAt > parsed.data.issuedAt + 30_000 || parsed.data.expiresAt > parsed.data.source.expiresAt) throw invalid();
    return parsed.data;
  }
}
