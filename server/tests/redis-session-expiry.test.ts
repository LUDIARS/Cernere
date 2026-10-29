import { describe, expect, it } from "vitest";
import { SESSION_TTL_SECS, sessionExpiry } from "../src/redis.js";

describe("WS session expiry", () => {
  const now = Date.parse("2026-10-30T00:00:00Z");

  it("ends at the access token's expiry instead of 7 days", () => {
    const tokenExp = now / 1000 + 15 * 60;
    expect(sessionExpiry(now + SESSION_TTL_SECS * 1000, tokenExp, now)).toBe(tokenExp * 1000);
  });

  it("keeps an earlier requested expiry", () => {
    expect(sessionExpiry(now + 60_000, now / 1000 + 900, now)).toBe(now + 60_000);
  });

  it("never exceeds 7 days even when the inputs are missing or invalid", () => {
    expect(sessionExpiry(Number.NaN, undefined, now)).toBe(now + SESSION_TTL_SECS * 1000);
    expect(sessionExpiry(now + 30 * 24 * 3600 * 1000, "x", now)).toBe(now + SESSION_TTL_SECS * 1000);
  });
});
