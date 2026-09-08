/** Google signing keys: bounded, expiring cache; tokens never choose a network URL. */
import { createPublicKey, type KeyObject } from "node:crypto";
import { AppError } from "../error.js";

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
type KeySet = { keys: Map<string, KeyObject>; expiresAt: number };

/** @implements SPEC-GOOGLE-OIDC-VERIFICATION */
export class GoogleSigningKeys {
  private cached: KeySet | undefined;
  private pending: Promise<KeySet> | undefined;
  private retryAfter = 0;

  constructor(private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  async get(kid: string): Promise<KeyObject> {
    const cachedKey = this.cached?.keys.get(kid);
    if (this.cached && this.cached.expiresAt > this.now() && cachedKey) {
      return cachedKey;
    }
    if (!this.pending) {
      // Refusing to refresh is an upstream/rate-limit condition, not a bad token: fail closed as 503
      // so a throttled window is not reported to the caller as an invalid Google identity.
      if (this.now() < this.retryAfter) {
        throw AppError.serviceUnavailable("Google signing keys are temporarily unavailable; retry sign-in");
      }
      // Unknown keys can trigger one refresh per minute, including failed requests.
      this.retryAfter = this.now() + 60_000;
      this.pending = this.fetchKeys().finally(() => { this.pending = undefined; });
    }
    const keySet = await this.pending;
    const key = keySet.keys.get(kid);
    // A kid absent from a freshly fetched key set is a property of the token itself.
    if (!key) throw AppError.unauthorized("Google signing key is unavailable");
    return key;
  }

  private async fetchKeys(): Promise<KeySet> {
    try {
      const response = await this.fetcher(JWKS_URL, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("JWKS request failed");
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("keys" in body)
        || !Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > 32) {
        throw new Error("Invalid JWKS");
      }
      const keys = new Map<string, KeyObject>();
      for (const entry of body.keys as unknown[]) {
        if (!entry || typeof entry !== "object") throw new Error("Invalid signing key");
        const raw = entry as Record<string, unknown>;
        if (raw.kty !== "RSA" || raw.alg !== "RS256" || raw.use !== "sig"
          || typeof raw.kid !== "string" || !raw.kid || raw.kid.length > 200
          || typeof raw.n !== "string" || !/^[A-Za-z0-9_-]{100,2048}$/.test(raw.n)
          || typeof raw.e !== "string" || !/^[A-Za-z0-9_-]{1,16}$/.test(raw.e) || keys.has(raw.kid)) {
          throw new Error("Invalid signing key");
        }
        const key = createPublicKey({ key: { kty: "RSA", n: raw.n, e: raw.e }, format: "jwk" });
        if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("Weak signing key");
        keys.set(raw.kid, key);
      }
      const cacheControl = response.headers.get("cache-control") ?? "";
      const seconds = Number(cacheControl.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1] ?? 0);
      const age = Math.max(0, Number(response.headers.get("age") ?? 0) || 0);
      const ttl = /\bno-(?:cache|store)\b/i.test(cacheControl) ? 0 : Math.max(0, Math.min(seconds - age, 3600));
      const result = { keys, expiresAt: this.now() + ttl * 1000 };
      this.cached = result;
      return result;
    } catch {
      // Never use expired keys or expose an upstream response in an authentication error.
      throw AppError.serviceUnavailable("Google signing keys could not be verified; retry sign-in");
    }
  }
}
