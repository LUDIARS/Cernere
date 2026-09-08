/** Validated Google OIDC identity. Google login alone is not evidence of enterprise MFA. */
import jwt from "jsonwebtoken";
import { AppError } from "../error.js";
import { GoogleSigningKeys } from "./google-signing-keys.js";

export interface GoogleIdentity {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

const signingKeys = new GoogleSigningKeys();

/** @implements SPEC-GOOGLE-OIDC-VERIFICATION */
export async function verifyGoogleIdToken(
  token: string,
  expected: { clientId: string; nonce: string; hostedDomains: readonly string[] },
  keys: GoogleSigningKeys = signingKeys,
  now: () => number = Date.now,
): Promise<GoogleIdentity> {
  if (!expected.clientId || !expected.nonce || token.length > 16384) throw AppError.unauthorized("Invalid Google ID token");
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || decoded.header.alg !== "RS256" || typeof decoded.header.kid !== "string"
    || !decoded.header.kid || decoded.header.kid.length > 200) throw AppError.unauthorized("Invalid Google ID token");
  const key = await keys.get(decoded.header.kid);
  try {
    const clock = Math.floor(now() / 1000);
    const claims = jwt.verify(token, key, { algorithms: ["RS256"], audience: expected.clientId,
      issuer: ["https://accounts.google.com", "accounts.google.com"], clockTimestamp: clock, clockTolerance: 60 });
    if (typeof claims === "string" || typeof claims.sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(claims.sub)
      || typeof claims.iat !== "number" || !Number.isInteger(claims.iat) || claims.iat > clock + 60
      || typeof claims.exp !== "number" || !Number.isInteger(claims.exp) || claims.exp <= claims.iat
      || claims.nonce !== expected.nonce
      || (claims.azp !== undefined && claims.azp !== expected.clientId)
      || (Array.isArray(claims.aud) && (claims.aud.length > 1 && claims.azp !== expected.clientId))
      || claims.email_verified !== true || typeof claims.email !== "string"
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email) || claims.email.length > 254) {
      throw new Error("Invalid identity claims");
    }
    if (expected.hostedDomains.length > 0
      && (typeof claims.hd !== "string" || !expected.hostedDomains.includes(claims.hd.toLowerCase()))) {
      throw new Error("Hosted domain is not allowed");
    }
    return {
      sub: claims.sub, email: claims.email,
      name: typeof claims.name === "string" && claims.name.trim() ? claims.name.trim().slice(0, 200) : undefined,
      picture: typeof claims.picture === "string" && /^https:\/\//i.test(claims.picture)
        && claims.picture.length <= 2048 ? claims.picture : undefined,
    };
  } catch {
    throw AppError.unauthorized("Google identity could not be verified");
  }
}
