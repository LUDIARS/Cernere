/** Password-login MFA completion shared by REST, guest WS and composite. @implements SPEC-MFA-CHALLENGE */
import { eq } from "drizzle-orm";
import { users, refreshSessions } from "../db/schema.js";
import { AppError } from "../error.js";
import { decryptSecret } from "../lib/crypto/secret-box.js";
import { generateTokenPair, REFRESH_TOKEN_DAYS } from "./jwt.js";
import { hashRefreshToken } from "./token-hash.js";
import { issueMfaTicket, readMfaTicket, consumeMfaTicket, countMfaAttempt, limitMfa, MFA_TTL_SECONDS,
  type MfaContext, type MfaMethod, type MfaTicket } from "./mfa-records.js";
import { mfaSnapshot, assertMfaSnapshot, enabledMfaMethods, loadMfaUser, withMfaUser,
  type MfaUser, type MfaTransaction } from "./mfa-user.js";
import { sendMfaMail, verifyMfaMail } from "./mfa-mail.js";
import { verifyTotpStep } from "./mfa-totp.js";
import type { MfaChallengeResult, MfaLoginResult } from "./mfa-contract.js";
import { logAuthEvent } from "../logging/auth-logger.js";
import { completedAuthentication, type AuthenticationEvidence } from "../lib/authentication-evidence.js";
import type { OnsiteRequirement } from "../project/onsite-mfa.js";
import { onsiteChallengeStore } from "./onsite-challenge-store.js";

/**
 * With an onsite requirement (a project that declares onsite_mfa), onsite is the only factor that
 * satisfies the challenge and the user's own MFA enrollment is irrelevant (SPEC-MFA-ONSITE).
 */
export async function beginMfaChallenge(user: MfaUser, context: MfaContext,
  onsite: OnsiteRequirement | null = null): Promise<MfaChallengeResult> {
  const mfaMethods: MfaMethod[] = onsite ? ["onsite"] : enabledMfaMethods(user);
  if (!onsite && !user.mfaEnabled) throw AppError.conflict("MFA is not enabled");
  if (mfaMethods.length === 0) throw AppError.serviceUnavailable("No supported MFA factor is configured. Use a registered passkey or another login method.");
  await limitMfa(`issue:${user.id}`, 10);
  const mfaToken = await issueMfaTicket({ userId: user.id, snapshot: mfaSnapshot(user),
    purpose: context.purpose, binding: context.binding ?? null, projectKey: context.projectKey ?? null,
    mfaRevision: user.mfaRevision, onsite });
  return { mfaRequired: true as const, mfaToken, mfaMethods };
}

/** The ticket's allowed factors: onsite tickets accept only onsite, others only the enrolled factors. */
function isMethodAllowed(user: MfaUser, ticket: MfaTicket, method: MfaMethod): boolean {
  if (ticket.record.onsite) return method === "onsite";
  return method !== "onsite" && user.mfaEnabled && enabledMfaMethods(user).includes(method);
}

/** Polling-friendly gate: until a kiosk attestation is accepted the device gets 409 onsite_pending. */
async function readOnsiteEvidence(ticket: MfaTicket): Promise<string> {
  await limitMfa(`onsite-poll:${ticket.digest}`, 300, MFA_TTL_SECONDS);
  const raw = await onsiteChallengeStore.readSatisfaction(ticket.digest);
  if (!raw) throw AppError.withCode(409, "onsite_pending", "onsite_pending");
  return raw;
}

function assertOnsiteEvidenceFor(user: MfaUser, raw: string): void {
  let userId: unknown;
  try { userId = (JSON.parse(raw) as { userId?: unknown }).userId; }
  catch { throw AppError.unauthorized("Onsite verification is invalid"); }
  if (userId !== user.id) throw AppError.unauthorized("Onsite verification does not match this user");
}

export async function sendMfaChallengeCode(token: string, method: MfaMethod, context: MfaContext): Promise<void> {
  const ticket = await readMfaTicket(token, context);
  const user = await loadMfaUser(ticket.record.userId);
  assertMfaSnapshot(user, ticket.record.snapshot);
  if (method !== "email" || !isMethodAllowed(user, ticket, method)) {
    throw AppError.badRequest("An enabled email MFA factor is required");
  }
  await sendMfaMail(ticket, user.email);
}

export async function verifyMfaChallenge<T>(token: string, method: MfaMethod, code: string,
  context: MfaContext, complete: (user: MfaUser, tx: MfaTransaction, authentication: AuthenticationEvidence) => Promise<T>): Promise<T> {
  const ticket = await readMfaTicket(token, context);
  // Onsite is polled every ~2s while the user stands at the kiosk, so it has its own bound
  // instead of the 5-attempt code-guessing budget; it carries no guessable secret.
  const onsiteRaw = method === "onsite" && ticket.record.onsite ? await readOnsiteEvidence(ticket) : undefined;
  if (onsiteRaw === undefined) await countMfaAttempt(ticket);
  const result = await withMfaUser(ticket.record.userId, async (user, tx) => {
    assertMfaSnapshot(user, ticket.record.snapshot);
    if (!isMethodAllowed(user, ticket, method)) throw AppError.unauthorized("MFA method is not enabled");
    let step: number | null = null;
    let mailRaw: string | undefined;
    if (method === "onsite") {
      if (onsiteRaw === undefined) throw AppError.unauthorized("MFA method is not enabled");
      assertOnsiteEvidenceFor(user, onsiteRaw);
    } else if (method === "totp") {
      if (!user.totpSecret) throw AppError.unauthorized("TOTP is not configured");
      step = verifyTotpStep(decryptSecret(user.totpSecret), code, user.totpLastStep ?? -1, Date.now());
      if (step === null) throw AppError.unauthorized("Invalid or already used Authenticator code. Wait for the next code.");
    } else {
      mailRaw = await verifyMfaMail(ticket, code);
    }
    const authentication = completedAuthentication(method, user.mfaRevision);
    // One atomic consume for all concurrent requests, before issuing any session/grant.
    await consumeMfaTicket(ticket, mailRaw, onsiteRaw);
    if (step !== null) await tx.update(users).set({ totpLastStep: step }).where(eq(users.id, user.id));
    return complete(user, tx, authentication);
  });
  logAuthEvent({ event: "user.mfa.verified", userId: ticket.record.userId, provider: method, purpose: context.purpose });
  return result;
}

export async function issueMfaLogin(user: MfaUser, tx: MfaTransaction, authentication: AuthenticationEvidence): Promise<MfaLoginResult> {
  const now = new Date();
  const tokens = await generateTokenPair(user.id, user.role, authentication, { authEpoch: user.authEpoch, database: tx });
  await tx.update(users).set({ lastLoginAt: now, updatedAt: now }).where(eq(users.id, user.id));
  await tx.insert(refreshSessions).values({ authEpoch: tokens.authEpoch, id: crypto.randomUUID(), userId: user.id,
    refreshToken: hashRefreshToken(tokens.refreshToken), authentication, expiresAt: new Date(now.getTime() + REFRESH_TOKEN_DAYS * 86400_000) });
  return { ...tokens, userId: user.id, user: { id: user.id, displayName: user.displayName, email: user.email, role: user.role } };
}
