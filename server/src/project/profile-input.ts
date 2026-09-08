/** Payload boundary for service profile commands; no identity or privilege mass assignment. */
import { z } from "zod";
import { PROFILE_READ_FIELDS } from "./profile-access.js";
import { AppError } from "../error.js";

const userId = z.string().uuid().transform((id) => id.toLowerCase());
export const profileReadSchema = z.object({
  userId,
  fields: z.array(z.enum(PROFILE_READ_FIELDS)).min(1).max(PROFILE_READ_FIELDS.length).optional(),
}).strict();
export const profileWriteSchema = z.object({
  userId,
  displayName: z.string().trim().min(1).max(200).optional(),
  avatarUrl: z.string().url().max(2048).refine((url) => /^https?:\/\//i.test(url)).nullable().optional(),
  bio: z.string().max(10000).optional(),
  roleTitle: z.string().max(500).optional(),
  expertise: z.array(z.string().max(500)).max(100).optional(),
  hobbies: z.array(z.string().max(500)).max(100).optional(),
}).strict();

/**
 * 未知項目を拒否し、identity / privilege の mass assignment を遮断する。
 *
 * @implements SPEC-PROFILE-INPUT-BOUNDARY
 */
export function parseProfileInput<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw AppError.badRequest("Invalid profile request");
  return parsed.data;
}
