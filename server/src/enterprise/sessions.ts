/** Revalidate enterprise authorization against current Cr state on every use. @implements SPEC-ENTERPRISE-SESSION */
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { enterpriseIdentities } from "../db/schema.js";
import { checkRateLimit, redis } from "../redis.js";
import { AppError } from "../error.js";
import { logAuthEvent } from "../logging/auth-logger.js";
import { requireConnection, requireMembership, subjectHash, revokeEnterpriseUser } from "./connections.js";
import { verifyCloudflareAuthentication } from "./cloudflare-assertion.js";
import { issueEnterpriseSession, readEnterpriseSession, deleteEnterpriseSession, enterpriseSessionKey, type EnterpriseSession } from "./session-store.js";

export interface EnterpriseSessionInfo {
  userId: string; projectKey: string; organizationId: string; organizationRole: string; authTime: number; amr: string[]; expiresAt: number;
}
export function publicEnterpriseSession(session: EnterpriseSession): EnterpriseSessionInfo {
  return { userId: session.userId, projectKey: session.projectKey, organizationId: session.organizationId,
    organizationRole: session.organizationRole, authTime: session.authTime, amr: session.amr, expiresAt: session.expiresAt };
}

async function identity(projectKey: string, digest: string) {
  const row = (await db.select().from(enterpriseIdentities).where(and(eq(enterpriseIdentities.projectKey, projectKey), eq(enterpriseIdentities.subjectHash, digest))).limit(1))[0];
  if (!row?.isActive) throw AppError.forbidden("Cloudflare identity has not been assigned to an active organization member");
  return row;
}

export async function enterpriseLogin(projectKey: string, assertion: string): Promise<{ enterpriseToken: string; session: EnterpriseSessionInfo }> {
  await checkRateLimit("enterprise-login:" + projectKey, 60, 60);
  const connection = await requireConnection(projectKey);
  const authentication = await verifyCloudflareAuthentication(connection, assertion);
  const digest = subjectHash(authentication.subject);
  const linked = await identity(projectKey, digest);
  const member = await requireMembership(connection, linked.userId);
  if (authentication.userId !== linked.userId || authentication.authenticationRevision !== member.authenticationRevision
    || authentication.authTime < Math.floor(Date.parse(member.joinedAt) / 1000)) {
    throw AppError.unauthorized("Cloudflare authentication predates the current membership or credentials");
  }
  const now = Math.floor(Date.now() / 1000);
  const record: EnterpriseSession = { userId: linked.userId, projectKey, organizationId: connection.organizationId,
    connectionRevision: connection.revision, identityRevision: linked.revision, subjectHash: digest,
    organizationRole: member.role, memberJoinedAt: member.joinedAt, authenticationRevision: member.authenticationRevision,
    authTime: authentication.authTime, amr: authentication.amr,
    expiresAt: Math.min(authentication.expiresAt, authentication.authTime + connection.maxAuthenticationAge, now + connection.maxSessionSeconds) };
  const token = await issueEnterpriseSession(record);
  try { await verifyEnterpriseSession(projectKey, token); }
  catch (error) { await deleteEnterpriseSession(token); throw error; }
  return { enterpriseToken: token, session: publicEnterpriseSession(record) };
}

export async function verifyEnterpriseSession(projectKey: string, token: string): Promise<EnterpriseSession> {
  const session = await readEnterpriseSession(token);
  if (session.projectKey !== projectKey) throw AppError.forbidden("Enterprise session belongs to another application");
  const connection = await requireConnection(projectKey);
  const linked = await identity(projectKey, session.subjectHash);
  const member = await requireMembership(connection, session.userId);
  if (connection.organizationId !== session.organizationId || connection.revision !== session.connectionRevision
    || linked.userId !== session.userId || linked.revision !== session.identityRevision
    || member.role !== session.organizationRole || member.joinedAt !== session.memberJoinedAt
    || member.authenticationRevision !== session.authenticationRevision || session.expiresAt * 1000 <= Date.now()) {
    throw AppError.unauthorized("Enterprise session expired or authorization changed");
  }
  return session;
}

export async function rotateEnterpriseSession(projectKey: string, token: string): Promise<{ enterpriseToken: string; session: EnterpriseSessionInfo }> {
  const session = await verifyEnterpriseSession(projectKey, token);
  // A rotation never extends Access's expiry or the original authentication age.
  // Mint and validate the replacement first: if issuing fails (e.g. the absolute deadline
  // has passed), the caller keeps a usable token instead of being left with neither.
  const replacement = await issueEnterpriseSession(session);
  try { await verifyEnterpriseSession(projectKey, replacement); }
  catch (error) { await deleteEnterpriseSession(replacement); throw error; }
  // Consume the presented token last, so a concurrent rotation loses the race cleanly.
  const consumed = await redis.getdel(enterpriseSessionKey(token));
  if (!consumed) {
    await deleteEnterpriseSession(replacement);
    throw AppError.unauthorized("Enterprise session already used or revoked");
  }
  return { enterpriseToken: replacement, session: publicEnterpriseSession(session) };
}

export async function enterpriseProjectCommand(projectKey: string, action: string, payload: Record<string, unknown>): Promise<unknown> {
  try {
    const result = await executeEnterpriseCommand(projectKey, action, payload);
    logAuthEvent({ event: "enterprise.session", projectKey, action });
    return result;
  } catch (error) {
    logAuthEvent({ event: "enterprise.session.failed", projectKey, action, error: "enterprise authorization rejected" });
    throw error;
  }
}

async function executeEnterpriseCommand(projectKey: string, action: string, payload: Record<string, unknown>): Promise<unknown> {
  const token = typeof payload.enterpriseToken === "string" ? payload.enterpriseToken : "";
  switch (action) {
    case "revoke_user":
      if (typeof payload.userId !== "string") throw AppError.badRequest("userId is required");
      return { revoked: await revokeEnterpriseUser(projectKey, payload.userId) };
    case "login": return enterpriseLogin(projectKey, typeof payload.assertion === "string" ? payload.assertion : "");
    case "verify": return publicEnterpriseSession(await verifyEnterpriseSession(projectKey, token));
    case "refresh": return rotateEnterpriseSession(projectKey, token);
    case "logout":
      await verifyEnterpriseSession(projectKey, token);
      await deleteEnterpriseSession(token);
      return { revoked: true };
    default: throw AppError.badRequest("Unknown enterprise session action");
  }
}
