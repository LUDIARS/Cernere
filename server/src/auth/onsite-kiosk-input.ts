/**
 * kiosk 公開鍵登録 API の入力検証 (契約 B)。
 *
 * 公開鍵は Ed25519 SPKI PEM だけを受け、 正規化した PEM を保存する。
 * lanUrl は利用者端末が nonce を送る施設 LAN 上の Ostiarius で、 https 以外は受けない。
 * @implements SPEC-MFA-ONSITE
 */

import { createPublicKey } from "node:crypto";
import { z } from "zod";
import { AppError } from "../error.js";
import { placeIdSchema } from "../project/onsite-mfa.js";

export const lanIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/, "invalid lanId");

const inputSchema = z.object({
  lanId: lanIdSchema,
  placeId: placeIdSchema,
  publicKeyPem: z.string().min(1).max(4096),
  lanUrl: z.string().min(1).max(2048),
  label: z.string().trim().min(1).max(128).optional(),
}).strict();

export interface OnsiteKioskInput {
  lanId: string;
  placeId: string;
  publicKeyPem: string;
  lanUrl: string;
  label: string | null;
}

/** Ed25519 の SPKI PEM でなければ例外。 戻り値は再エンコードした正規形。 */
export function normalizeEd25519PublicKeyPem(pem: string): string {
  let key;
  try { key = createPublicKey({ key: pem, format: "pem" }); }
  catch { throw AppError.badRequest("publicKeyPem must be an SPKI PEM public key"); }
  if (key.asymmetricKeyType !== "ed25519") throw AppError.badRequest("publicKeyPem must be an Ed25519 public key");
  return key.export({ type: "spki", format: "pem" }).toString();
}

/** https の origin + path だけを許す。 資格情報・query・fragment 付きの URL は受けない。 */
export function normalizeLanUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw AppError.badRequest("lanUrl must be an absolute https URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw AppError.badRequest("lanUrl must be an https URL without credentials, query or fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

export function parseOnsiteKioskInput(body: unknown): OnsiteKioskInput {
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) throw AppError.badRequest("Invalid onsite kiosk registration");
  return {
    lanId: parsed.data.lanId,
    placeId: parsed.data.placeId,
    publicKeyPem: normalizeEd25519PublicKeyPem(parsed.data.publicKeyPem),
    lanUrl: normalizeLanUrl(parsed.data.lanUrl),
    label: parsed.data.label ?? null,
  };
}
