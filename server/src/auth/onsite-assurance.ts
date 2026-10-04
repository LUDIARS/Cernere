/**
 * kiosk の本人確認手段 (method / assurance) が onsite 要求を満たすかの判定
 * (Ostiarius spec onsite-mfa-factor.md §5)。
 *
 * - staff_override (manual) / session / password (low) は MFA として受理しない
 * - passkey (kiosk 経由、 medium) は要求値が medium 以下なら受理する
 * - 要求値 high は assurance high (face) だけが満たす
 * @implements SPEC-MFA-ONSITE
 */

import type { OnsiteMinAssurance } from "../project/onsite-mfa.js";

/** Ostiarius server/attestation.ts の AttestationMethod / AttestationAssurance と同じ語彙。 */
export const ATTESTATION_METHODS = ["face", "face_passive", "passkey", "staff_override", "session", "password"] as const;
export const ATTESTATION_ASSURANCES = ["high", "medium", "manual", "low"] as const;
export type AttestationMethod = (typeof ATTESTATION_METHODS)[number];
export type AttestationAssurance = (typeof ATTESTATION_ASSURANCES)[number];

const NEVER_MFA_METHODS: ReadonlySet<string> = new Set(["staff_override", "session", "password"]);
const RANK: Readonly<Record<string, number>> = { medium: 1, high: 2 };

export function meetsOnsiteAssurance(method: AttestationMethod | undefined, assurance: AttestationAssurance | undefined,
  minimum: OnsiteMinAssurance): boolean {
  if (!method || !assurance || NEVER_MFA_METHODS.has(method)) return false;
  const actual = RANK[assurance];
  return actual !== undefined && actual >= RANK[minimum];
}
