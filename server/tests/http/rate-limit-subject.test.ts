import { describe, expect, it } from "vitest";
import { rateLimitSubject, wideRateLimitSubject } from "../../src/http/rate-limit-subject.js";

describe("rate-limit subjects", () => {
  it("keeps IPv4 addresses and groups them by /24 for the wide key", () => {
    expect(rateLimitSubject("203.0.113.7")).toBe("203.0.113.7");
    expect(wideRateLimitSubject("203.0.113.7")).toBe("203.0.113.0/24");
  });

  it("groups every address of one IPv6 /64 into one key", () => {
    const a = rateLimitSubject("2001:db8:1:2:aaaa::1");
    const b = rateLimitSubject("2001:0db8:0001:0002:ffff:ffff:ffff:ffff");
    expect(a).toBe("2001:db8:1:2::/64");
    expect(b).toBe(a);
    expect(rateLimitSubject("2001:db8:1:3::1")).not.toBe(a);
  });

  it("expands :: and embedded IPv4 before taking the prefix", () => {
    expect(rateLimitSubject("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitSubject("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitSubject("64:ff9b::192.0.2.33")).toBe("64:ff9b:0:0::/64");
    expect(wideRateLimitSubject("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1::/48");
  });

  it("falls back to anon for missing or invalid input", () => {
    expect(rateLimitSubject(undefined)).toBe("anon");
    expect(rateLimitSubject("not-an-ip")).toBe("anon");
    expect(wideRateLimitSubject("")).toBe("anon");
  });
});
