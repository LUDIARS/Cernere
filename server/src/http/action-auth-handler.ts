import crypto from "node:crypto";

import { eq } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { z } from "zod";

import { actionTargetSchema, ACTION_AUTH_TTL_SECONDS } from "../auth/action-policy.js";
import {
  actionProofStore,
  httpActionBinding,
  wsActionBinding,
} from "../auth/action-proof.js";
import { extractBearerToken, verifyToken } from "../auth/jwt.js";
import { config } from "../config.js";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { checkRateLimit, redis } from "../redis.js";

interface RouteResult { status: string; data: unknown }

const beginSchema = actionTargetSchema.extend({
  sessionId: z.string().uuid().optional(),
}).strict();

const finishSchema = z.object({
  ceremonyId: z.string().uuid(),
  response: z.object({ id: z.string().min(1).max(2048) }).passthrough(),
}).strict();

interface PendingActionAuthentication {
  challenge: string;
  userId: string;
  targetSessionId?: string;
  action: z.infer<typeof actionTargetSchema>["action"];
  resource: string;
}

export async function handleActionAuthRoute(
  phase: string,
  body: string,
  authHeader: string,
): Promise<RouteResult> {
  switch (phase) {
    case "begin": return begin(parseBody(body), authHeader);
    case "finish": return finish(parseBody(body), authHeader);
    default: return { status: "404 Not Found", data: { error: `Unknown action auth phase: ${phase}` } };
  }
}

async function begin(payload: unknown, authHeader: string): Promise<RouteResult> {
  const parsed = beginSchema.safeParse(payload);
  if (!parsed.success) throw AppError.badRequest("A supported action and resource are required");
  const { userId } = requireUser(authHeader);
  await checkRateLimit(`action-auth:${userId}`, 30, 5 * 60);

  const credentials = await db.select({
    id: schema.passkeys.id,
    credentialId: schema.passkeys.credentialId,
    transports: schema.passkeys.transports,
  }).from(schema.passkeys).where(eq(schema.passkeys.userId, userId));
  if (credentials.length === 0) {
    throw AppError.forbidden("A passkey must be registered before this action can be authorized");
  }

  const options = await generateAuthenticationOptions({
    rpID: config.webauthnRpId,
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: Array.isArray(credential.transports)
        ? credential.transports as AuthenticatorTransportFuture[]
        : undefined,
    })),
    userVerification: "required",
  });
  const ceremonyId = crypto.randomUUID();
  const pending: PendingActionAuthentication = {
    challenge: options.challenge,
    userId,
    targetSessionId: parsed.data.sessionId,
    action: parsed.data.action,
    resource: parsed.data.resource,
  };
  await redis.set(pendingKey(ceremonyId), JSON.stringify(pending), "EX", ACTION_AUTH_TTL_SECONDS);
  return { status: "200 OK", data: { ceremonyId, options } };
}

async function finish(payload: unknown, authHeader: string): Promise<RouteResult> {
  const parsed = finishSchema.safeParse(payload);
  if (!parsed.success) throw AppError.badRequest("ceremonyId and response are required");
  const { userId, token } = requireUser(authHeader);

  const raw = await redis.getdel(pendingKey(parsed.data.ceremonyId));
  if (!raw) throw AppError.forbidden("Action authentication challenge expired or already used");
  let pending: PendingActionAuthentication;
  try {
    pending = JSON.parse(raw) as PendingActionAuthentication;
  } catch {
    throw AppError.forbidden("Action authentication challenge is invalid");
  }
  if (pending.userId !== userId) {
    throw AppError.forbidden("Action authentication does not belong to this session");
  }

  const response = parsed.data.response as unknown as AuthenticationResponseJSON;
  const credential = (await db.select().from(schema.passkeys)
    .where(eq(schema.passkeys.credentialId, response.id)).limit(1))[0];
  if (!credential || credential.userId !== userId) {
    throw AppError.forbidden("Passkey does not belong to this user");
  }

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: config.webauthnOrigins,
      expectedRPID: config.webauthnRpId,
      credential: {
        id: credential.credentialId,
        publicKey: new Uint8Array(credential.publicKey),
        counter: Number(credential.counter),
        transports: Array.isArray(credential.transports)
          ? credential.transports as AuthenticatorTransportFuture[]
          : undefined,
      },
      requireUserVerification: true,
    });
  } catch {
    throw AppError.forbidden("Passkey verification failed");
  }
  if (!verification.verified) throw AppError.forbidden("Passkey verification failed");

  await db.update(schema.passkeys).set({
    counter: verification.authenticationInfo.newCounter,
    lastUsedAt: new Date(),
  }).where(eq(schema.passkeys.id, credential.id));

  const issued = await actionProofStore.issue({
    userId,
    binding: pending.targetSessionId
      ? wsActionBinding(pending.targetSessionId)
      : httpActionBinding(token),
    action: pending.action,
    resource: pending.resource,
  });
  return { status: "200 OK", data: issued };
}

function requireUser(authHeader: string): { userId: string; token: string } {
  const token = extractBearerToken(authHeader);
  if (!token) throw AppError.unauthorized("Missing bearer token");
  const claims = verifyToken(token);
  return { userId: claims.sub, token };
}

function parseBody(body: string): unknown {
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw AppError.badRequest("Request body must be valid JSON");
  }
}

function pendingKey(ceremonyId: string): string {
  return `action-auth:challenge:${ceremonyId}`;
}
