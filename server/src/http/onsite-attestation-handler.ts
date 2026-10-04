/**
 * Ostiarius → Cernere の現地確認 attestation 受け口 (契約 C)。
 *
 *   POST /api/mfa/onsite/attestations   Bearer: Ostiarius の project credentials 由来 token
 *   body { attestation: "<payload>.<sig>" }
 *   200 { accepted: true } / 4xx { error: <固定語彙のコード> }
 *
 * scope `onsite-mfa:submit` は呼出元 project の service_scopes 宣言 (管理者所有) で決まる。
 * @implements SPEC-MFA-ONSITE
 */

import { z } from "zod";
import { submitOnsiteAttestation } from "../auth/onsite-challenge.js";
import { onsiteAttestationError } from "../auth/onsite-attestation.js";
import { requireProjectServiceScope } from "./project-service-scope-auth.js";

export const ONSITE_MFA_SUBMIT_SCOPE = "onsite-mfa:submit";

const bodySchema = z.object({ attestation: z.string() }).strict();

export async function handleOnsiteAttestation(authHeader: string, body: unknown): Promise<{ accepted: true }> {
  const principal = await requireProjectServiceScope(authHeader, ONSITE_MFA_SUBMIT_SCOPE);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) throw onsiteAttestationError("invalid_format");
  return submitOnsiteAttestation(parsed.data.attestation, principal.projectKey);
}
