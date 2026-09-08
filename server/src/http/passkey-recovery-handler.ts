/** A recovery grant can enroll a verified passkey, never mint an access token. @implements SPEC-DEVICE-RECOVERY */
import { randomUUID } from "node:crypto";
import { generateRegistrationOptions, verifyRegistrationResponse, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config.js";
import { AppError } from "../error.js";
import { redis, checkRateLimit } from "../redis.js";
import { passkeys } from "../db/schema.js";
import { resolveGrant, completeRecovery, hashGrantToken } from "../auth/registration-grant.js";
import { mergeWebauthnOrigins } from "../auth/webauthn-origins.js";
import { logAuthEvent } from "../logging/auth-logger.js";

const pendingSchema = z.object({ userId: z.string().uuid(), grantHash: z.string(), challenge: z.string(), expiresAt: z.number() }).strict();
const inputSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), ceremonyId: z.string().uuid().optional(), response: z.unknown().optional() }).strict();

export async function handlePasskeyRecovery(action: string, input: unknown, ip?: string): Promise<{ status: string; data: unknown }> {
  await checkRateLimit("passkey-recovery:" + (ip ?? "unknown"), 15, 60);
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw AppError.badRequest("Invalid recovery request");
  const p = parsed.data;
  if (action === "recovery-begin") {
    const grant = await resolveGrant(p.token);
    const options = await generateRegistrationOptions({ rpName: config.webauthnRpName, rpID: config.webauthnRpId,
      // 登録 / device link (passkey-handler.ts) と同一の user handle 導出を使う。
      // ここだけ別の handle にすると、 authenticator 上で同じ user が別アカウントとして
      // 並び、 discoverable login の userHandle 解決も食い違う。
      userID: new TextEncoder().encode(grant.subjectUserId), userName: "Recovered account", userDisplayName: "Recovered account",
      attestationType: "none", authenticatorSelection: { residentKey: "required", userVerification: "required" }, supportedAlgorithmIDs: [-7, -257] });
    const ceremonyId = randomUUID(), expiresAt = Math.min(grant.expiresAt.getTime(), Date.now() + 300_000);
    const ttl = Math.floor((expiresAt - Date.now()) / 1000);
    if (ttl <= 0) throw AppError.unauthorized("Recovery grant expired");
    await redis.set("recovery-ceremony:" + ceremonyId, JSON.stringify({ userId: grant.subjectUserId, grantHash: hashGrantToken(p.token), challenge: options.challenge, expiresAt }), "EX", ttl);
    return { status: "200 OK", data: { ceremonyId, options } };
  }
  if (action !== "recovery-finish" || !p.ceremonyId || !p.response) throw AppError.badRequest("Recovery ceremony required");
  const raw = await redis.getdel("recovery-ceremony:" + p.ceremonyId);
  const pending = pendingSchema.safeParse(raw ? JSON.parse(raw) : null);
  if (!pending.success || pending.data.expiresAt <= Date.now() || pending.data.grantHash !== hashGrantToken(p.token)) {
    throw AppError.unauthorized("Recovery ceremony expired or invalid");
  }
  const response = p.response as RegistrationResponseJSON;
  const verification = await verifyRegistrationResponse({ response, expectedChallenge: pending.data.challenge,
    expectedOrigin: mergeWebauthnOrigins(config.webauthnOrigins, config.compositeAllowedOrigins), expectedRPID: config.webauthnRpId, requireUserVerification: true });
  if (!verification.verified || !verification.registrationInfo) throw AppError.unauthorized("Passkey verification failed");
  const info = verification.registrationInfo;
  await completeRecovery({ token: p.token, expectedSubjectUserId: pending.data.userId, insertPasskey: async (tx, userId) => {
    if (pending.data.expiresAt <= Date.now()) throw AppError.unauthorized("Recovery ceremony expired");
    // credential_id は UNIQUE。 既に (他 user 含め) 登録済みの authenticator を
    // 使うと制約違反で 500 になるため、 事前に検出して意味のある応答にする。
    const existing = (await tx.select({ userId: passkeys.userId }).from(passkeys)
      .where(eq(passkeys.credentialId, info.credential.id)).limit(1))[0];
    if (existing) throw AppError.badRequest("This passkey is already registered. Use a different authenticator.");
    await tx.insert(passkeys).values({ id: randomUUID(), userId, credentialId: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey), counter: info.credential.counter, deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp, transports: response.response.transports ?? [], discoverable: true, aaguid: info.aaguid });
  } });
  logAuthEvent({ event: "user.passkey.recovered", userId: pending.data.userId });
  return { status: "200 OK", data: { recovered: true } };
}
