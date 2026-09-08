/** Service profile reads/writes enforce grants, user privacy and atomic updates. */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { resolveProfileAccess, resolveProfileReadFields, assertProfileWriteFields, PERSONALITY_FIELDS,
  type ProfileAccess, type ProfileReadField } from "./profile-access.js";
import { parseProfileInput, profileReadSchema, profileWriteSchema } from "./profile-input.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function loadGrant(tx: Transaction, projectKey: string, userId: string): Promise<ProfileAccess> {
  const [project] = await tx.select({ definition: schema.managedProjects.schemaDefinition })
    .from(schema.managedProjects).where(and(eq(schema.managedProjects.key, projectKey),
      eq(schema.managedProjects.isActive, true))).limit(1).for("share");
  if (!project) throw AppError.forbidden("Active service profile_access grant is required");
  return resolveProfileAccess(project.definition, userId);
}

async function personalityOptedOut(tx: Transaction, projectKey: string, userId: string): Promise<boolean> {
  const rows = await tx.select({ userId: schema.userDataOptouts.userId }).from(schema.userDataOptouts)
    .where(and(eq(schema.userDataOptouts.userId, userId),
      inArray(schema.userDataOptouts.serviceId, ["core", projectKey]),
      eq(schema.userDataOptouts.categoryKey, "personality"))).limit(1);
  return rows.length > 0;
}

export async function getServiceProfile(projectKey: string, payload: unknown): Promise<Record<string, unknown>> {
  const p = parseProfileInput(profileReadSchema, payload);
  return db.transaction(async (tx) => {
    const fields = resolveProfileReadFields(await loadGrant(tx, projectKey, p.userId), p.fields);
    const [row] = await tx.select({
      login: schema.users.login, displayName: schema.users.displayName, email: schema.users.email,
      avatarUrl: schema.users.avatarUrl, role: schema.users.role,
      profile: { bio: schema.userProfiles.bio, roleTitle: schema.userProfiles.roleTitle,
        expertise: schema.userProfiles.expertise, hobbies: schema.userProfiles.hobbies, privacy: schema.userProfiles.privacy },
    }).from(schema.users).leftJoin(schema.userProfiles, eq(schema.users.id, schema.userProfiles.userId))
      .where(eq(schema.users.id, p.userId)).limit(1);
    if (!row) throw AppError.notFound("User not found");
    const blocked = await personalityOptedOut(tx, projectKey, p.userId);
    const privacy = row.profile?.privacy as Record<string, unknown> | null | undefined;
    const values: Record<ProfileReadField, unknown> = {
      login: row.login, displayName: row.displayName, email: row.email, avatarUrl: row.avatarUrl,
      role: row.role, bio: row.profile?.bio ?? "", roleTitle: row.profile?.roleTitle ?? "",
      expertise: row.profile?.expertise ?? [], hobbies: row.profile?.hobbies ?? [],
    };
    const result: Record<string, unknown> = { id: p.userId };
    for (const field of fields) {
      // Existing rows require an explicit public flag; malformed privacy never exposes a value.
      if (PERSONALITY_FIELDS.has(field) && (blocked || (row.profile && privacy?.[field] !== true))) continue;
      result[field] = values[field];
    }
    return result;
  });
}

export async function updateServiceProfile(projectKey: string, payload: unknown): Promise<{ id: string; updated: string[] }> {
  const p = parseProfileInput(profileWriteSchema, payload);
  const fields = Object.keys(p).filter((field) => field !== "userId" && p[field as keyof typeof p] !== undefined);
  if (fields.length === 0) throw AppError.badRequest("No profile fields to update");
  return db.transaction(async (tx) => {
    assertProfileWriteFields(await loadGrant(tx, projectKey, p.userId), fields);
    if (fields.some((field) => PERSONALITY_FIELDS.has(field)) && await personalityOptedOut(tx, projectKey, p.userId)) {
      throw AppError.forbidden("User opted out of personality data updates");
    }
    const [user] = await tx.select({ id: schema.users.id }).from(schema.users)
      .where(eq(schema.users.id, p.userId)).limit(1).for("update");
    if (!user) throw AppError.notFound("User not found");
    const now = new Date();
    const userPatch: Partial<typeof schema.users.$inferInsert> = { updatedAt: now };
    if (p.displayName !== undefined) {
      userPatch.displayName = p.displayName;
      // A service grant is delegated editing, not an automatic IdP refresh.
      userPatch.displayNameSource = "user";
    }
    if (p.avatarUrl !== undefined) userPatch.avatarUrl = p.avatarUrl;
    if (Object.keys(userPatch).length > 1) {
      await tx.update(schema.users).set(userPatch).where(eq(schema.users.id, p.userId));
    }
    const profilePatch: Partial<typeof schema.userProfiles.$inferInsert> = { updatedAt: now };
    if (p.bio !== undefined) profilePatch.bio = p.bio;
    if (p.roleTitle !== undefined) profilePatch.roleTitle = p.roleTitle;
    if (p.expertise !== undefined) profilePatch.expertise = p.expertise;
    if (p.hobbies !== undefined) profilePatch.hobbies = p.hobbies;
    if (Object.keys(profilePatch).length > 1) {
      await tx.insert(schema.userProfiles).values({ userId: p.userId, ...profilePatch })
        .onConflictDoUpdate({ target: schema.userProfiles.userId, set: profilePatch });
    }
    // Write permission never grants a read of the resulting profile.
    return { id: p.userId, updated: fields };
  });
}
