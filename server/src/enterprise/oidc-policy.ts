/** Current authorization requirements for Cr-issued OIDC grants. @implements SPEC-ENTERPRISE-OIDC */
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users } from "../db/schema.js";
import { AppError } from "../error.js";
import { readAuthenticationEvidence, type AuthenticationEvidence } from "../lib/authentication-evidence.js";
import { isAuthenticationCurrent, type AuthenticationRequirement } from "../lib/authentication-freshness.js";
import { connectionForClient, requireConnection, requireMembership } from "./connections.js";

export interface EnterpriseGrant {
  projectKey: string; organizationId: string; revision: string; role: string; joinedAt: string; expiresAt: number;
}
export type OidcAuthenticationPolicy = AuthenticationRequirement;

export async function checkOidcAuthentication(clientId: string, userId: string, value: unknown,
  policy?: OidcAuthenticationPolicy, previous?: EnterpriseGrant): Promise<{ authentication?: AuthenticationEvidence; enterprise?: EnterpriseGrant }> {
  const configured = await connectionForClient(clientId);
  const authentication = readAuthenticationEvidence(value);
  if (!authentication && (configured || previous || policy?.forceReauth || policy?.maxAge !== undefined)) {
    throw AppError.unauthorized("再認証が必要です。パスキー、またはパスワードと MFA でログインしてください。");
  }
  const now = Date.now();
  if (authentication) {
    const user = (await db.select({ revision: users.mfaRevision }).from(users).where(eq(users.id, userId)).limit(1))[0];
    if (!user || !isAuthenticationCurrent(authentication, user.revision, policy, now)) {
      throw AppError.unauthorized("認証が古くなりました。再度ログインしてください。");
    }
  }
  if (!configured) {
    if (previous) throw AppError.forbidden("Enterprise connection was removed");
    return { authentication };
  }
  if (!policy && !previous) throw AppError.forbidden("Enterprise connection changed after consent");
  const connection = await requireConnection(configured.projectKey);
  const member = await requireMembership(connection, userId);
  if (!authentication || (connection.requireMfa && !authentication.amr.includes("mfa"))) {
    throw AppError.unauthorized("企業ポリシーには MFA が必要です。パスキー、または MFA を設定して再度ログインしてください。");
  }
  const expiresAt = previous?.expiresAt ?? Math.min(authentication.authTime + connection.maxAuthenticationAge,
    Math.floor(now / 1000) + connection.maxSessionSeconds);
  if (expiresAt * 1000 <= now || now >= authentication.authTimeMs + connection.maxAuthenticationAge * 1000) {
    throw AppError.unauthorized("企業認証の有効期間を過ぎました。再度ログインしてください。");
  }
  const enterprise: EnterpriseGrant = { projectKey: connection.projectKey, organizationId: connection.organizationId,
    revision: connection.revision, role: member.role, joinedAt: member.joinedAt, expiresAt };
  if (previous && (previous.projectKey !== enterprise.projectKey || previous.organizationId !== enterprise.organizationId
    || previous.revision !== enterprise.revision || previous.role !== enterprise.role || previous.joinedAt !== enterprise.joinedAt)) {
    throw AppError.forbidden("Enterprise authorization changed");
  }
  return { authentication, enterprise };
}

export function enterpriseOidcClaims(grant?: EnterpriseGrant): Record<string, unknown> {
  return grant ? { cr_project: grant.projectKey, cr_organization: grant.organizationId, cr_organization_role: grant.role,
    cr_connection_revision: grant.revision } : {};
}
