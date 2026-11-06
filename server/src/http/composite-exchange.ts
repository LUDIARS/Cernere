/** Credential exchange boundaries for service and Cernere-only authorization codes. */
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { AppError } from "../error.js";
import { authCodeStore } from "../auth/auth-code.js";
import { extractBearerToken, verifyProjectToken, generateTokenPair, REFRESH_TOKEN_DAYS } from "../auth/jwt.js";
import { hashRefreshToken } from "../auth/token-hash.js";
import { assertUserSessionCurrent } from "../auth/user-session-state.js";
import { signProjectToken } from "../auth/paseto.js";
import { projectCompositeTarget, registeredHubUrl } from "../auth/composite-redirect.js";
import { isCurrentProjectCredential } from "../project/project-credential-state.js";
import { loadServiceIdentity, requireServiceAccess } from "../federation/subject.js";
import { enforceServiceConsent } from "../consent/gate.js";
import { isCernereFrontendOrigin } from "./cernere-origin.js";
import { COMPOSITE_GRANT_TTL_SECONDS, createCompositeGrant } from "../auth/composite-grant.js";
import { getConsentRecord } from "../consent/store.js";
import { getProjectUserPermissions } from "../project/user-permissions.js";
import { serviceUserView } from "../auth/service-user-view.js";

const invalidCode = (): AppError => AppError.unauthorized("Invalid or expired auth code");
const str = (value: unknown): string => typeof value === "string" ? value : "";

export async function exchangeServiceCode(input: Record<string, unknown>, authHeader: string): Promise<{ status: string; data: unknown }> {
  let claims: ReturnType<typeof verifyProjectToken>;
  try { claims = verifyProjectToken(extractBearerToken(authHeader) ?? ""); } catch { throw invalidCode(); }
  if (!await isCurrentProjectCredential(claims.sub, claims.projectKey, claims.credentialGeneration ?? 0)) throw invalidCode();
  const record = await authCodeStore.consume(str(input.code), { audience: "service", projectKey: claims.projectKey, codeVerifier: str(input.code_verifier) });
  if (!record || record.binding.audience !== "service") throw invalidCode();
  const project = await projectCompositeTarget(claims.sub, record.binding.origin);
  const audience = registeredHubUrl(project.schemaDefinition, project.key);
  await assertUserSessionCurrent(record.subject);
  await requireServiceAccess(record.subject.sub);
  const identity = await loadServiceIdentity(record.subject.sub);
  if (!identity) throw invalidCode();
  await enforceServiceConsent({ userId: record.subject.sub, displayName: identity.displayName,
    email: identity.email, role: identity.role, authEpoch: record.subject.authEpoch,
    authentication: record.subject.authentication, deviceId: record.subject.deviceId }, {
    subject: { projectKey: project.key }, channel: "service", deliverAuthCode: false, requireConsent: true,
  });
  const consent = await getConsentRecord(identity.subject, { kind: "project", key: project.key });
  if (consent?.revoked) throw invalidCode();
  const grantId = await createCompositeGrant({ projectKey: project.key, audience, subjectId: identity.subject,
    role: identity.role, source: record.subject, consentRevision: consent?.decidedAt ?? null });
  const projectToken = await signProjectToken({ userId: identity.subject, projectKey: project.key,
    role: identity.role, displayName: identity.displayName, audience, ttlSec: COMPOSITE_GRANT_TTL_SECONDS,
    compositeGrant: { version: 1, id: grantId } });
  const permissions = await getProjectUserPermissions(project.key, identity.subject);
  return { status: "200 OK", data: { user: serviceUserView(identity, permissions.permissions), projectToken } };
}

export async function exchangeSelfCode(input: Record<string, unknown>, origin?: string): Promise<{ status: string; data: unknown }> {
  if (!isCernereFrontendOrigin(origin)) throw invalidCode();
  const record = await authCodeStore.consume(str(input.code), { audience: "cernere", origin: origin ?? "", codeVerifier: str(input.code_verifier) });
  if (!record) throw invalidCode();
  await assertUserSessionCurrent(record.subject);
  const user = (await db.select().from(schema.users).where(eq(schema.users.id, record.subject.sub)).limit(1))[0];
  if (!user) throw invalidCode();
  const { accessToken, refreshToken, authEpoch } = await generateTokenPair(user.id, user.role ?? "general", record.subject.authentication,
    { authEpoch: record.subject.authEpoch, deviceId: record.subject.deviceId });
  await db.insert(schema.refreshSessions).values({ id: crypto.randomUUID(), userId: user.id, authEpoch,
    refreshToken: hashRefreshToken(refreshToken), authentication: record.subject.authentication, deviceId: record.subject.deviceId,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_DAYS * 86_400_000) });
  return { status: "200 OK", data: { accessToken, refreshToken, user: { id: user.id, displayName: user.displayName, email: user.email, role: user.role } } };
}
