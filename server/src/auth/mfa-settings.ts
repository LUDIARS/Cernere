/** Factor enrollment and removal after fresh, user-bound authorization. @implements SPEC-MFA-SETTINGS */
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users, passkeys, refreshSessions } from "../db/schema.js";
import { AppError } from "../error.js";
import { redis } from "../redis.js";
import { encryptSecret, decryptSecret } from "../lib/crypto/secret-box.js";
import { actionProofStore, httpActionBinding } from "./action-proof.js";
import { beginMfaChallenge, verifyMfaChallenge } from "./mfa-challenge.js";
import { issueMfaTicket, readMfaTicket, consumeMfaTicket, countMfaAttempt, limitMfa, remainingMfaSeconds,
  type MfaMethod, type MfaTicket } from "./mfa-records.js";
import { loadMfaUser, withMfaUser, mfaSnapshot, assertMfaSnapshot, enabledMfaMethods, type MfaUser } from "./mfa-user.js";
import { newTotpSecret, totpProvisioningUri, verifyTotpStep } from "./mfa-totp.js";
import { sendMfaMail, verifyMfaMail, isMfaMailConfigured } from "./mfa-mail.js";
import type { MfaStatusResult, MfaManagementResult, MfaChallengeResult } from "./mfa-contract.js";
import { logAuthEvent } from "../logging/auth-logger.js";

export interface MfaActor { userId: string; token: string; actionProof?: string }

export async function mfaStatus(userId: string): Promise<MfaStatusResult> {
  const user = await loadMfaUser(userId);
  const hasPasskey = (await db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, userId)).limit(1)).length > 0;
  return { mfaEnabled: user.mfaEnabled, methods: enabledMfaMethods(user), totpEnabled: user.totpEnabled,
    emailEnabled: Array.isArray(user.mfaMethods) && user.mfaMethods.includes("email"),
    hasPassword: Boolean(user.passwordHash), hasPasskey, hasEmail: Boolean(user.email),
    totpAvailable: Boolean(process.env.CERNERE_SECRET_KEY), emailMfaAvailable: isMfaMailConfigured(),
    hasPhone: Boolean(user.phoneNumber), phoneVerified: user.phoneVerified, smsAvailable: false };
}

async function issueManagement(user: MfaUser, actor: MfaActor): Promise<MfaManagementResult> {
  return { managementToken: await issueMfaTicket({ userId: user.id, purpose: "settings",
    snapshot: mfaSnapshot(user), binding: httpActionBinding(actor.token), projectKey: null }) };
}

export async function beginMfaManagement(actor: MfaActor, password?: string): Promise<MfaManagementResult | MfaChallengeResult> {
  const user = await loadMfaUser(actor.userId);
  if (actor.actionProof) {
    // A passkey proof is already single-use and server-issued, so it needs no guess budget.
    await actionProofStore.consume(actor.actionProof, { userId: user.id, binding: httpActionBinding(actor.token), action: "mfa.manage", resource: user.id });
    return issueManagement(user, actor);
  }
  // Budget the password guesses only. Counting successes too would lock a legitimate
  // user out of their own MFA settings after a handful of ordinary factor changes.
  await limitMfa(`manage:${actor.userId}`, 10);
  if (!user.passwordHash || !password || !await bcrypt.compare(password, user.passwordHash)) {
    throw AppError.forbidden("Re-enter your password or verify a registered passkey");
  }
  if (user.mfaEnabled) return beginMfaChallenge(user, { purpose: "manage", binding: httpActionBinding(actor.token) });
  return issueManagement(user, actor);
}

export async function verifyMfaManagement(actor: MfaActor, token: string, method: MfaMethod, code: string): Promise<MfaManagementResult> {
  return verifyMfaChallenge(token, method, code, { purpose: "manage", binding: httpActionBinding(actor.token) },
    async (user) => {
      if (user.id !== actor.userId) throw AppError.forbidden("MFA user mismatch");
      return issueManagement(user, actor);
    });
}

async function settingsTicket(actor: MfaActor, token: string): Promise<MfaTicket> {
  const ticket = await readMfaTicket(token, { purpose: "settings", binding: httpActionBinding(actor.token) });
  if (ticket.record.userId !== actor.userId) throw AppError.forbidden("MFA user mismatch");
  return ticket;
}

export async function setupTotp(actor: MfaActor, token: string): Promise<{ secret: string; provisioningUri: string }> {
  const ticket = await settingsTicket(actor, token);
  const user = await loadMfaUser(actor.userId);
  assertMfaSnapshot(user, ticket.record.snapshot);
  if (user.totpEnabled) throw AppError.conflict("Authenticator is already registered. Disable it before replacement.");
  const key = `mfa-setup:${ticket.digest}`;
  const candidate = encryptSecret(newTotpSecret());
  await redis.set(key, candidate, "EX", remainingMfaSeconds(ticket), "NX");
  const stored = await redis.get(key);
  if (!stored) throw AppError.unauthorized("MFA setup expired");
  const secret = decryptSecret(stored);
  return { secret, provisioningUri: totpProvisioningUri(secret, user.email ?? user.login) };
}

export async function setupEmailMfa(actor: MfaActor, token: string): Promise<void> {
  const ticket = await settingsTicket(actor, token);
  const user = await loadMfaUser(actor.userId);
  assertMfaSnapshot(user, ticket.record.snapshot);
  if (enabledMfaMethods(user).includes("email")) throw AppError.conflict("Email MFA is already enabled");
  await sendMfaMail(ticket, user.email);
}

export async function changeMfaFactor(actor: MfaActor, token: string, method: MfaMethod, enable: boolean, code = ""): Promise<void> {
  const ticket = await settingsTicket(actor, token);
  await countMfaAttempt(ticket);
  await withMfaUser(actor.userId, async (user, tx) => {
    assertMfaSnapshot(user, ticket.record.snapshot);
    const methods = enabledMfaMethods(user);
    if (methods.includes(method) === enable) throw AppError.conflict("MFA factor already has the requested state");
    let totpSecret = user.totpSecret;
    let totpLastStep = user.totpLastStep;
    let mailRaw: string | undefined;
    if (enable && method === "totp") {
      totpSecret = await redis.get(`mfa-setup:${ticket.digest}`);
      if (!totpSecret) throw AppError.unauthorized("Start Authenticator setup first");
      totpLastStep = verifyTotpStep(decryptSecret(totpSecret), code, -1, Date.now());
      if (totpLastStep === null) throw AppError.unauthorized("Invalid Authenticator code");
    }
    if (enable && method === "email") mailRaw = await verifyMfaMail(ticket, code);
    if (!enable && method === "totp") { totpSecret = null; totpLastStep = null; }
    await consumeMfaTicket(ticket, mailRaw);
    // Preserve unsupported legacy methods; this operation must not silently disable them.
    const previous = Array.isArray(user.mfaMethods) ? user.mfaMethods.filter((item): item is string => typeof item === "string") : [];
    const next = enable ? [...new Set([...previous, method])] : previous.filter((item) => item !== method);
    await tx.update(users).set({ totpSecret, totpLastStep,
      totpEnabled: method === "totp" ? enable : user.totpEnabled,
      mfaMethods: next, mfaEnabled: next.length > 0, mfaRevision: user.mfaRevision + 1, updatedAt: new Date() }).where(eq(users.id, user.id));
    await tx.delete(refreshSessions).where(eq(refreshSessions.userId, user.id));
  });
  logAuthEvent({ event: "user.mfa.settings.changed", userId: actor.userId, provider: method, enabled: enable });
}
