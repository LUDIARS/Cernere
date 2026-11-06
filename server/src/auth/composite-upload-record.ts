/** Bounded transfer metadata; no authority may widen a previously fixed operation.
 * @implements SPEC-COMPOSITE-UPLOAD-RESERVATION
 */
import { z } from "zod";
import { delegationRecordSchema } from "./composite-delegation-store.js";
import { MAX_UPLOAD_BYTES, uploadLimitsSchema } from "../project/service-operation-policy.js";
export { uploadLimitsSchema } from "../project/service-operation-policy.js";
export type UploadLimits = z.infer<typeof uploadLimitsSchema>;

export const uploadArrivalSchema = z.object({
  version: z.literal(1), delegation: delegationRecordSchema,
  byteLength: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  limits: uploadLimitsSchema,
}).strict().superRefine((arrival, ctx) => {
  const delegation = arrival.delegation;
  if (delegation.risk !== "important" || arrival.byteLength > arrival.limits.maximumBytes
    || delegation.expiresAt > delegation.issuedAt + 30_000 || delegation.expiresAt > delegation.source.expiresAt) {
    ctx.addIssue({ code: "custom", message: "Invalid bounded upload arrival" });
  }
});
export type UploadArrival = z.infer<typeof uploadArrivalSchema>;

export const uploadReservationSchema = z.object({
  version: z.literal(1), arrival: uploadArrivalSchema,
  requestBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  begunAt: z.number().finite().positive(), deadline: z.number().finite().positive(),
  limits: uploadLimitsSchema,
}).strict().superRefine((reservation, ctx) => {
  const { arrival, limits, begunAt, deadline } = reservation;
  if (begunAt < arrival.delegation.issuedAt || begunAt >= arrival.delegation.expiresAt
    || limits.maximumBytes > arrival.limits.maximumBytes || limits.timeoutSeconds > arrival.limits.timeoutSeconds
    || arrival.byteLength > limits.maximumBytes || deadline <= begunAt
    || deadline > begunAt + limits.timeoutSeconds * 1000 || deadline > arrival.delegation.source.expiresAt) {
    ctx.addIssue({ code: "custom", message: "Invalid bounded upload reservation" });
  }
});
export type UploadReservation = z.infer<typeof uploadReservationSchema>;
export interface UploadTarget {
  projectKey: string;
  audience: string;
  credentialGeneration: number;
  requestBinding: string;
}
