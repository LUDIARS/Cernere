/** Password-login MFA completion shared by REST, guest WS and composite. @implements SPEC-MFA-CHALLENGE */
import { eq } from "drizzle-orm";
import { users, refreshSessions } from "../db/schema.js";
import { AppError } from "../error.js";
import { decryptSecret } from "../lib/crypto/secret-box.js";
import { generateTokenPair, REFRESH_TOKEN_DAYS } from "./jwt.js";
import { hashRefreshToken } from "./token-hash.js";
import { issueMfaTicket, readMfaTicket, consumeMfaTicket, countMfaAttempt, limitMfa,
  type MfaContext, type MfaMethod } from "./mfa-records.js";
import { mfaSnapshot, assertMfaSnapshot, enabledMfaMethods, loadMfaUser, withMfaUser,
  type MfaUser, type MfaTransaction } from "./mfa-user.js";
import { sendMfaMail, verifyMfaMail } from "./mfa-mail.js";
import { verifyTotpStep } from "./mfa-totp.js";
import type { MfaChallengeResult, MfaLoginResult } from "./mfa-contract.js";
import { logAuthEvent } from "../logging/auth-logger.js";

export async function beginMfaChallenge(user: MfaUser, context: MfaContext): Promise<MfaChallengeResult> {
  const mfaMethods = enabledMfaMethods(user);
  if (!user.mfaEnabled) throw AppError.conflict("MFA is not enabled");
  if (mfaMethods.length === 0) throw AppError.serviceUnavailable("No supported MFA factor is configured. Use a registered passkey or another login method.");
  await limitMfa(`issue:${user.id}`, 10);
  const mfaToken = await issueMfaTicket({ userId: user.id, snapshot: mfaSnapshot(user),
    purpose: context.purpose, binding: context.binding ?? null, projectKey: context.projectKey ?? null });
  return { mfaRequired: true as const, mfaToken, mfaMethods };
}

export async function sendMfaChallengeCode(token: string, method: MfaMethod, context: MfaContext): Promise<void> {
  const ticket = await readMfaTicket(token, context);
  const user = await loadMfaUser(ticket.record.userId);
  assertMfaSnapshot(user, ticket.record.snapshot);
  if (method !== "email" || !user.mfaEnabled || !enabledMfaMethods(user).includes(method)) {
    throw AppError.badRequest("An enabled email MFA factor is required");
  }
  await sendMfaMail(ticket, user.email);
}

export async function verifyMfaChallenge<T>(token: string, method: MfaMethod, code: string,
  context: MfaContext, complete: (user: MfaUser, tx: MfaTransaction) => Promise<T>): Promise<T> {
  const ticket = await readMfaTicket(token, context);
  await countMfaAttempt(ticket);
  const result = await withMfaUser(ticket.record.userId, async (user, tx) => {
    assertMfaSnapshot(user, ticket.record.snapshot);
    if (!user.mfaEnabled || !enabledMfaMethods(user).includes(method)) throw AppError.unauthorized("MFA method is not enabled");
    let step: number | null = null;
    let mailRaw: string | undefined;
    if (method === "totp") {
      if (!user.totpSecret) throw AppError.unauthorized("TOTP is not configured");
      step = verifyTotpStep(decryptSecret(user.totpSecret), code, user.totpLastStep ?? -1, Date.now());
      if (step === null) throw AppError.unauthorized("Invalid or already used Authenticator code. Wait for the next code.");
    } else {
      mailRaw = await verifyMfaMail(ticket, code);
    }
    // One atomic consume for all concurrent requests, before issuing any session/grant.
    await consumeMfaTicket(ticket, mailRaw);
    if (step !== null) await tx.update(users).set({ totpLastStep: step }).where(eq(users.id, user.id));
    return complete(user, tx);
  });
  logAuthEvent({ event: "user.mfa.verified", userId: ticket.record.userId, provider: method, purpose: context.purpose });
  return result;
}

export async function issueMfaLogin(user: MfaUser, tx: MfaTransaction): Promise<MfaLoginResult> {
  const now = new Date();
  const tokens = await generateTokenPair(user.id, user.role, undefined, { authEpoch: user.authEpoch, database: tx });
  await tx.update(users).set({ lastLoginAt: now, updatedAt: now }).where(eq(users.id, user.id));
  await tx.insert(refreshSessions).values({ authEpoch: tokens.authEpoch, id: crypto.randomUUID(), userId: user.id,
    refreshToken: hashRefreshToken(tokens.refreshToken), expiresAt: new Date(now.getTime() + REFRESH_TOKEN_DAYS * 86400_000) });
  return { ...tokens, userId: user.id, user: { id: user.id, displayName: user.displayName, email: user.email, role: user.role } };
}
