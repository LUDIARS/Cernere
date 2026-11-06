/** Authorization codes carry a purpose-bound subject, never bearer credentials. */
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { redis } from "../redis.js";
import { requireServiceAccess } from "../federation/subject.js";
import { enforceServiceConsent, type ServiceConsentRequest } from "../consent/gate.js";
import { assertUserSessionCurrent, currentUserSessionState, type UserSessionState } from "./user-session-state.js";
import { AuthCodeStore, type AuthCodeBinding } from "./auth-code-store.js";
import { projectCompositeTarget } from "./composite-redirect.js";
import type { AuthenticationEvidence } from "../lib/authentication-evidence.js";

export const authCodeStore = new AuthCodeStore(redis);
export type AuthCodeAudience = AuthCodeBinding["audience"];
export interface AuthCodeUser {
  audience?: AuthCodeAudience;
  binding?: AuthCodeBinding;
  authentication?: AuthenticationEvidence;
  authEpoch?: number;
  deviceId?: string;
  userId: string;
  displayName: string;
  email: string | null;
  role: string;
  service?: ServiceConsentRequest;
}

export async function issueAuthCode(user: AuthCodeUser): Promise<string> {
  const binding = user.binding ?? user.service?.authCodeBinding;
  if (!binding || (user.audience && user.audience !== binding.audience)) throw new Error("Authorization code binding is required");
  const current = await currentUserSessionState(user.userId);
  const subject = { ...current, authEpoch: user.authEpoch ?? current.authEpoch,
    authentication: user.authentication, deviceId: user.deviceId };
  await assertUserSessionCurrent(subject);
  if (binding.audience === "service") {
    await requireServiceAccess(user.userId);
    const rows = await db.select({ clientId: schema.managedProjects.clientId }).from(schema.managedProjects)
      .where(eq(schema.managedProjects.key, binding.projectKey)).limit(1);
    await projectCompositeTarget(rows[0]?.clientId ?? "", binding.origin);
    if (!user.service) throw new Error("Service consent context is required");
    await enforceServiceConsent({ ...user, authEpoch: subject.authEpoch }, {
      ...user.service, subject: { projectKey: binding.projectKey }, authCodeBinding: binding, requireConsent: true,
    });
  }
  if (binding.audience === "kiosk") await requireServiceAccess(user.userId);
  return authCodeStore.issue(binding, subject);
}

export async function issueAuthCodeForUserId(userId: string, service: ServiceConsentRequest, source?: UserSessionState): Promise<string | null> {
  if (source && source.sub !== userId) throw new Error("Auth code source mismatch");
  const user = (await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1))[0];
  if (!user) return null;
  return issueAuthCode({ userId, displayName: user.displayName ?? "", email: user.email, role: user.role ?? "general",
    authentication: source?.authentication, authEpoch: source?.authEpoch, deviceId: source?.deviceId, service });
}
