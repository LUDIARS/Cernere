/** Administrator-owned grants for service access to common profile fields. */
import { z } from "zod";
import { AppError } from "../error.js";

export const PROFILE_READ_FIELDS = ["login", "displayName", "email", "avatarUrl", "role",
  "bio", "roleTitle", "expertise", "hobbies"] as const;
export const PROFILE_WRITE_FIELDS = ["displayName", "avatarUrl", "bio", "roleTitle", "expertise", "hobbies"] as const;
export type ProfileReadField = typeof PROFILE_READ_FIELDS[number];
export type ProfileWriteField = typeof PROFILE_WRITE_FIELDS[number];
export const PERSONALITY_FIELDS: ReadonlySet<string> = new Set(["bio", "roleTitle", "expertise", "hobbies"]);

export const profileAccessSchema = z.object({
  // "all" is an explicit administrator grant, never a default or a service self-declaration.
  users: z.union([z.literal("all"), z.array(z.string().uuid().transform((id) => id.toLowerCase())).max(10000)]),
  read: z.array(z.enum(PROFILE_READ_FIELDS)).max(PROFILE_READ_FIELDS.length),
  write: z.array(z.enum(PROFILE_WRITE_FIELDS)).max(PROFILE_WRITE_FIELDS.length),
}).strict();
export type ProfileAccess = z.infer<typeof profileAccessSchema>;

export function resolveProfileAccess(definition: unknown, userId: string): ProfileAccess {
  const raw = definition && typeof definition === "object" && "profile_access" in definition
    ? definition.profile_access : undefined;
  const parsed = profileAccessSchema.safeParse(raw);
  if (!parsed.success) throw AppError.forbidden("Service profile_access grant is missing or invalid");
  if (parsed.data.users !== "all" && !parsed.data.users.includes(userId.toLowerCase())) {
    throw AppError.forbidden("User is outside the service profile_access grant");
  }
  return parsed.data;
}

export function resolveProfileReadFields(grant: ProfileAccess, requested?: ProfileReadField[]): ProfileReadField[] {
  const fields = requested ?? grant.read;
  if (fields.length === 0 || fields.some((field) => !grant.read.includes(field))) {
    throw AppError.forbidden("Requested profile fields are not readable by this service");
  }
  return [...new Set(fields)];
}

export function assertProfileWriteFields(grant: ProfileAccess, fields: readonly string[]): void {
  if (fields.length === 0 || fields.some((field) => !grant.write.includes(field as ProfileWriteField))) {
    throw AppError.forbidden("Requested profile fields are not writable by this service");
  }
}
