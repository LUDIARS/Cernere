/** Existing kiosk MFA, bound to one project-token issuance. @implements SPEC-MFA-ONSITE */
import { AppError } from "../error.js";
import type { OnsiteRequirement } from "../project/onsite-mfa.js";
import { beginMfaChallenge, verifyMfaChallenge } from "./mfa-challenge.js";
import { readMfaTicket, type MfaContext } from "./mfa-records.js";
import { loadMfaUser } from "./mfa-user.js";
import { httpActionBinding } from "./action-proof.js";
import type { MfaChallengeResult } from "./mfa-contract.js";
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:ff75ee4f */
import augurContract_8f485db7 from './contracts/project-token-onsite.contract.js'; /* augur-inject:contract-predicate:57f88af1 */

interface ProjectTokenOnsiteInput {
  userId: string;
  bearerToken: string;
  projectKey: string;
  requirement: OnsiteRequirement | null;
  mfaToken?: string;
}

/** null permits signing; a challenge response carries no project token. */
export async function authorizeProjectTokenOnsite(input: ProjectTokenOnsiteInput): Promise<MfaChallengeResult | null> {
  if (!input.requirement) return null;
  const context: MfaContext = {
    purpose: "project-token", binding: httpActionBinding(input.bearerToken), projectKey: input.projectKey,
  };
  if (!input.mfaToken) {
    return beginMfaChallenge(await loadMfaUser(input.userId), context, input.requirement);
  }
  const ticket = await readMfaTicket(input.mfaToken, context);
  const onsite = ticket.record.onsite;
  // Re-read policy on every attempt: a ticket cannot keep an older, weaker requirement alive.
  if (ticket.record.userId !== input.userId || !onsite
    || onsite.minAssurance !== input.requirement.minAssurance
    || JSON.stringify(onsite.allowedPlaceIds) !== JSON.stringify(input.requirement.allowedPlaceIds)) {
    throw AppError.forbidden("Onsite challenge does not match the current project requirement");
  }
  await verifyMfaChallenge(input.mfaToken, "onsite", "", context, async (user) => {
    if (user.id !== input.userId) throw AppError.forbidden("Onsite verification does not match this user");
  });
  return null;
}
// @ts-expect-error augur-inject
authorizeProjectTokenOnsite = contract(authorizeProjectTokenOnsite, { ...augurContract_8f485db7, contractId: 'C-37', mode: 'observe', sample: 1, where: 'server/src/auth/project-token-onsite.ts:19', rule: 'contract-wrap', id: '8f485db7' }); /* augur-inject:contract-wrap:8f485db7 */
