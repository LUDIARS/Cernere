/**
 * kiosk (Ostiarius) が送る purpose:"mfa" attestation の検証 (契約 A / C、 Os spec §4.2)。
 *
 * 形式: base64url(JSON payload) + "." + base64url(Ed25519 署名)。 署名対象は payload の
 * base64url 文字列そのもの (Ostiarius の signAttestation と同一)。 検証順は §4.2 の 1〜7 に固定し、
 * 失敗は固定語彙のエラーコードだけで返す (顔画像・テンプレート・スコアは扱わない)。
 *
 * この module は副作用を持たない。 kiosk・challenge・利用者状態の参照は deps で受け、
 * 受理後の nonce 一回消費と充足の記録は呼出側 (onsite-challenge.ts) が原子的に行う。
 * @implements SPEC-MFA-ONSITE
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { z } from "zod";
import { AppError } from "../error.js";
import { ATTESTATION_ASSURANCES, ATTESTATION_METHODS, meetsOnsiteAssurance,
  type AttestationAssurance, type AttestationMethod } from "./onsite-assurance.js";
import type { OnsiteTicketRequirement } from "./mfa-records.js";

export const ONSITE_FRESHNESS_MS = 120_000;
const MAX_ATTESTATION_LENGTH = 4096;

export const ONSITE_ATTESTATION_ERRORS = [
  "invalid_format", "unknown_kiosk", "revoked_kiosk", "invalid_signature", "purpose_mismatch",
  "nonce_unknown", "nonce_used", "subject_mismatch", "stale", "assurance_insufficient",
  "place_not_allowed", "mfa_revision_changed",
] as const;
export type OnsiteAttestationErrorCode = (typeof ONSITE_ATTESTATION_ERRORS)[number];

const STATUS: Readonly<Record<OnsiteAttestationErrorCode, number>> = {
  invalid_format: 400, stale: 400,
  unknown_kiosk: 401, revoked_kiosk: 401, invalid_signature: 401,
  purpose_mismatch: 403, subject_mismatch: 403, assurance_insufficient: 403, place_not_allowed: 403,
  nonce_unknown: 404,
  nonce_used: 409, mfa_revision_changed: 409,
};

/** 応答本文は `{ error: <code> }` に固定する (契約 C)。 message も code と同じにしておく。 */
export function onsiteAttestationError(code: OnsiteAttestationErrorCode): AppError {
  return AppError.withCode(STATUS[code], code, code);
}

const payloadSchema = z.object({
  sub: z.string().min(1).max(128),
  placeId: z.string().min(1).max(128),
  lanId: z.string().min(1).max(128),
  nonce: z.string().min(1).max(128),
  issuedAt: z.number().int().nonnegative(),
  method: z.enum(ATTESTATION_METHODS).optional(),
  assurance: z.enum(ATTESTATION_ASSURANCES).optional(),
  // Missing purpose means the legacy attendance format (contract A).
  purpose: z.enum(["attendance", "mfa"]).optional(),
}).strict();
export type OnsiteAttestationPayload = z.infer<typeof payloadSchema>;

export interface ParsedAttestation { body: string; signature: Buffer; payload: OnsiteAttestationPayload }

const B64URL = /^[A-Za-z0-9_-]+$/;

export function parseOnsiteAttestation(token: unknown): ParsedAttestation {
  if (typeof token !== "string" || token.length > MAX_ATTESTATION_LENGTH) throw onsiteAttestationError("invalid_format");
  const parts = token.split(".");
  if (parts.length !== 2 || !B64URL.test(parts[0]) || !B64URL.test(parts[1])) throw onsiteAttestationError("invalid_format");
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); }
  catch { throw onsiteAttestationError("invalid_format"); }
  const parsed = payloadSchema.safeParse(decoded);
  if (!parsed.success) throw onsiteAttestationError("invalid_format");
  return { body: parts[0], signature: Buffer.from(parts[1], "base64url"), payload: parsed.data };
}

export interface OnsiteKioskKey { lanId: string; placeId: string; publicKeyPem: string; status: string }

export type OnsiteNonceLookup =
  | { state: "unknown" }
  | { state: "used" }
  | { state: "active"; ticketDigest: string; userId: string; mfaRevision: number | undefined; requirement: OnsiteTicketRequirement | null };

export interface OnsiteAttestationDeps {
  findKiosk(lanId: string): Promise<OnsiteKioskKey | null>;
  lookupNonce(nonce: string): Promise<OnsiteNonceLookup>;
  currentMfaRevision(userId: string): Promise<number | null>;
  now(): number;
}

/** 受理時に ticket へ記録する充足。 顔データは含めない。 */
export interface OnsiteSatisfaction {
  userId: string;
  method: AttestationMethod;
  assurance: AttestationAssurance;
  placeId: string;
  lanId: string;
  issuedAt: number;
  acceptedAt: number;
}

export interface AcceptedOnsiteAttestation {
  nonce: string;
  ticketDigest: string;
  requirement: OnsiteTicketRequirement;
  satisfaction: OnsiteSatisfaction;
}

function verifySignature(parsed: ParsedAttestation, publicKeyPem: string): boolean {
  try {
    return cryptoVerify(null, Buffer.from(parsed.body), createPublicKey(publicKeyPem), parsed.signature);
  } catch {
    // A malformed stored key or signature length is a verification failure, never acceptance.
    return false;
  }
}

/** Os spec §4.2 の 1〜7 をこの順に検証する。 nonce の消費はしない (呼出側が原子的に行う)。 */
export async function checkOnsiteAttestation(token: unknown, deps: OnsiteAttestationDeps): Promise<AcceptedOnsiteAttestation> {
  const parsed = parseOnsiteAttestation(token);
  const { payload } = parsed;

  // 1. signature with a registered, non-revoked kiosk key
  const kiosk = await deps.findKiosk(payload.lanId);
  if (!kiosk) throw onsiteAttestationError("unknown_kiosk");
  if (kiosk.status !== "active") throw onsiteAttestationError("revoked_kiosk");
  if (!verifySignature(parsed, kiosk.publicKeyPem)) throw onsiteAttestationError("invalid_signature");

  // 2. purpose
  if ((payload.purpose ?? "attendance") !== "mfa") throw onsiteAttestationError("purpose_mismatch");

  // 3. binding: nonce belongs to a live onsite challenge of the same subject
  const challenge = await deps.lookupNonce(payload.nonce);
  if (challenge.state === "unknown") throw onsiteAttestationError("nonce_unknown");
  if (challenge.state === "used") throw onsiteAttestationError("nonce_used");
  if (!challenge.requirement) throw onsiteAttestationError("nonce_unknown");
  if (payload.sub !== challenge.userId) throw onsiteAttestationError("subject_mismatch");

  // 4. freshness (one-time nonce consumption is committed by the caller)
  const now = deps.now();
  if (Math.abs(now - payload.issuedAt) > ONSITE_FRESHNESS_MS) throw onsiteAttestationError("stale");

  // 5. assurance
  if (!meetsOnsiteAssurance(payload.method, payload.assurance, challenge.requirement.minAssurance)) {
    throw onsiteAttestationError("assurance_insufficient");
  }

  // 6. place: the kiosk's registered place, and the project's allowed places when specified
  const allowed = challenge.requirement.allowedPlaceIds;
  if (payload.placeId !== kiosk.placeId || (allowed && !allowed.includes(payload.placeId))) {
    throw onsiteAttestationError("place_not_allowed");
  }

  // 7. MFA settings unchanged since the challenge was issued
  const revision = await deps.currentMfaRevision(challenge.userId);
  if (revision === null || challenge.mfaRevision === undefined || revision !== challenge.mfaRevision) {
    throw onsiteAttestationError("mfa_revision_changed");
  }

  return {
    nonce: payload.nonce,
    ticketDigest: challenge.ticketDigest,
    requirement: challenge.requirement,
    satisfaction: {
      userId: challenge.userId,
      // Narrowed by step 5: both are present and acceptable.
      method: payload.method as AttestationMethod,
      assurance: payload.assurance as AttestationAssurance,
      placeId: payload.placeId,
      lanId: payload.lanId,
      issuedAt: payload.issuedAt,
      acceptedAt: now,
    },
  };
}
