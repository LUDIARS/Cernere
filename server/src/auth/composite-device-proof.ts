import { createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db/connection.js";
import { deviceCredentials } from "../db/schema.js";
import { AppError } from "../error.js";
import { checkRateLimit, redis } from "../redis.js";
import { readAuthenticationEvidence } from "../lib/authentication-evidence.js";
import { issueAuthCodeForUserId } from "./auth-code.js";
import type { AuthCodeBinding } from "./auth-code-store.js";
import { assertDeviceOrigin } from "./device-origin.js";
import { currentUserSessionState } from "./user-session-state.js";
import { loadSessionKeyMaterial } from "./session-keys.js";

interface Context { origin?: string; deviceIp?: string }
type Service = Extract<AuthCodeBinding, { audience: "service" }>;

export function trustedDeviceContext(ctx: Context, binding: AuthCodeBinding): { project: string; ipTag: string } {
  assertDeviceOrigin(ctx.origin ?? "");
  if (!config.deviceSessionsEnabled || binding.audience !== "service" || !ctx.deviceIp) {
    throw AppError.forbidden("Registered device access is unavailable");
  }
  // A loopback hop without verified forwarding is not the client's address.
  if (ctx.deviceIp.startsWith("127.") || ctx.deviceIp === "::1") throw AppError.forbidden("Client IP is unavailable");
  const ipTag = createHmac("sha256", loadSessionKeyMaterial().master)
    .update("composite-device-ip\0" + ctx.deviceIp).digest("base64url");
  return { project: binding.projectKey, ipTag };
}

export function readDevicePublicKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{120,128}$/.test(value)) throw AppError.badRequest("Invalid device public key");
  try {
    const key = createPublicKey({ key: Buffer.from(value, "base64url"), format: "der", type: "spki" });
    if (key.asymmetricKeyDetails?.namedCurve === "prime256v1"
      && key.export({ format: "der", type: "spki" }).toString("base64url") === value) return value;
  } catch { /* Reject invalid DER below. */ }
  throw AppError.badRequest("Invalid device public key");
}

const invalid = () => AppError.unauthorized("Device verification failed");
const challengeKey = (nonce: string) => "composite:device:proof:" + nonce;

export async function compositeDeviceProof(action: "begin" | "finish", body: Record<string, unknown>,
  ctx: Context, binding: Service): Promise<{ challenge: string } | { authCode: string }> {
  const { ipTag } = trustedDeviceContext(ctx, binding);
  await checkRateLimit("device-proof:" + ipTag, 120, 60);
  const id = z.string().uuid().safeParse(body.deviceId);
  if (!id.success || typeof body.target !== "string" || typeof body.state !== "string"
    || !/^[A-Za-z0-9_-]{32,512}$/.test(body.state)) throw invalid();
  const mode = body.targetMode;
  if (mode !== "redirect" && mode !== "post_message") throw invalid();
  const intent = JSON.stringify([id.data, ipTag, binding.projectKey, binding.origin, binding.codeChallenge, body.target, mode, body.state]);
  if (action === "begin") {
    const challenge = randomBytes(32).toString("base64url");
    await redis.set(challengeKey(challenge), intent, "EX", 60);
    return { challenge };
  }
  const { challenge, signature } = body;
  if (typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)
    || typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) throw invalid();
  if (await redis.getdel(challengeKey(challenge)) !== intent) throw invalid();
  const [row] = await db.select().from(deviceCredentials).where(and(eq(deviceCredentials.id, id.data),
    eq(deviceCredentials.proofIpTag, ipTag), eq(deviceCredentials.proofProject, binding.projectKey), isNull(deviceCredentials.revokedAt))).limit(1);
  if (!row?.proofPublicKey || row.expiresAt.getTime() <= Date.now()) throw invalid();
  const key = createPublicKey({ key: Buffer.from(row.proofPublicKey, "base64url"), format: "der", type: "spki" });
  if (!verify("sha256", Buffer.from(challenge, "ascii"), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))) throw invalid();
  const current = await currentUserSessionState(row.userId);
  const authentication = readAuthenticationEvidence(row.authentication);
  if (!authentication || row.authEpoch === null) throw invalid();
  // issueAuthCode checks revocation, root passkey, key rotation, MFA revision, service access and consent.
  const code = await issueAuthCodeForUserId(row.userId, { subject: { projectKey: binding.projectKey },
    authCodeBinding: binding, continuation: { mode, target: body.target, state: body.state }, channel: "browser" },
    { ...current, deviceId: row.id, authEpoch: row.authEpoch, authentication });
  if (!code) throw invalid();
  return { authCode: code };
}
