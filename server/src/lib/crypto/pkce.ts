import { createHash, timingSafeEqual } from "node:crypto";

/** RFC 7636 S256. plain and non-ASCII verifiers are never accepted. @implements SPEC-COMPOSITE-PROJECT-PKCE */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier) || !isPkceS256Challenge(codeChallenge)) return false;
  const computed = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
  return timingSafeEqual(Buffer.from(computed, "ascii"), Buffer.from(codeChallenge, "ascii"));
}

/** @implements SPEC-COMPOSITE-PROJECT-PKCE */
export function isPkceS256Challenge(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)
    && Buffer.from(value, "base64url").toString("base64url") === value;
}
