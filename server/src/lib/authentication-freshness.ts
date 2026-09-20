/** Authentication freshness is measured at factor verification, never at token issuance. @implements SPEC-ENTERPRISE-AUTH-FACTS */
import type { AuthenticationEvidence } from "./authentication-evidence.js";

export interface AuthenticationRequirement { createdAtMs: number; forceReauth: boolean; maxAge?: number }
export function isAuthenticationCurrent(authentication: AuthenticationEvidence, revision: number,
  policy?: AuthenticationRequirement, now = Date.now()): boolean {
  return revision === authentication.revision && authentication.authTimeMs <= now
    && Math.floor(authentication.authTimeMs / 1000) === authentication.authTime
    && (!policy?.forceReauth || authentication.authTimeMs >= policy.createdAtMs)
    && (policy?.maxAge === undefined || policy.maxAge === 0 || now < authentication.authTimeMs + policy.maxAge * 1000);
}
