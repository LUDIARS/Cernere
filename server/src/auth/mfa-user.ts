/** Persisted factor state and its concurrent-update boundary. @implements SPEC-MFA-SETTINGS */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users } from "../db/schema.js";
import { AppError } from "../error.js";
import type { MfaMethod } from "./mfa-records.js";

export type MfaUser = typeof users.$inferSelect;
export type MfaTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function loadMfaUser(userId: string): Promise<MfaUser> {
  const user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!user) throw AppError.unauthorized("User no longer exists");
  return user;
}

export async function withMfaUser<T>(userId: string, action: (user: MfaUser, tx: MfaTransaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const user = (await tx.select().from(users).where(eq(users.id, userId)).for("update"))[0];
    if (!user) throw AppError.unauthorized("User no longer exists");
    return action(user, tx);
  });
}

/** Changing a factor, password, or destination invalidates outstanding challenges and enrollment. */
export function mfaSnapshot(user: MfaUser): string {
  return createHash("sha256").update(JSON.stringify([
    user.passwordHash, user.email, user.mfaEnabled, user.mfaMethods, user.totpEnabled, user.totpSecret, user.mfaRevision,
  ])).digest("hex");
}

export function assertMfaSnapshot(user: MfaUser, expected: string): void {
  if (mfaSnapshot(user) !== expected) throw AppError.conflict("Authentication settings changed. Start again.");
}

export function enabledMfaMethods(user: MfaUser): MfaMethod[] {
  const configured = Array.isArray(user.mfaMethods) ? user.mfaMethods : [];
  const methods: MfaMethod[] = [];
  if (user.totpEnabled && user.totpSecret && configured.includes("totp")) methods.push("totp");
  if (user.email && configured.includes("email")) methods.push("email");
  return methods;
}
