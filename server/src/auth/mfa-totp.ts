/** Authenticator-compatible RFC 6238 primitives. @implements SPEC-MFA-TOTP */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_PERIOD_SECONDS = 30;

export function newTotpSecret(): string {
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of randomBytes(20)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += BASE32[(value >>> bits) & 31];
    }
  }
  return encoded;
}

function decodeSecret(secret: string): Buffer {
  if (!/^[A-Z2-7]{32}$/.test(secret)) throw new Error("Invalid TOTP key encoding");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of secret) {
    value = (value << 5) | BASE32.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  return Buffer.from(bytes);
}

function codeAt(key: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** The caller must persist the returned step atomically with successful verification. */
export function verifyTotpStep(secret: string, code: string, lastStep: number, nowMs: number): number | null {
  if (!/^\d{6}$/.test(code) || !Number.isFinite(nowMs) || nowMs < 0) return null;
  const key = decodeSecret(secret);
  try {
    const current = Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
    let matched: number | null = null;
    for (const step of [current - 1, current, current + 1]) {
      if (step < 0) continue;
      const equal = timingSafeEqual(Buffer.from(codeAt(key, step)), Buffer.from(code));
      if (equal && step > lastStep) matched = step;
    }
    return matched;
  } finally {
    key.fill(0);
  }
}

export function totpProvisioningUri(secret: string, account: string): string {
  const query = new URLSearchParams({ secret, issuer: "Cernere", algorithm: "SHA1", digits: "6", period: "30" });
  // The key URI format reserves ':' as the issuer/account separator.
  return `otpauth://totp/${encodeURIComponent(`Cernere:${account.replaceAll(":", " ")}`)}?${query}`;
}
