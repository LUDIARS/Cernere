import { describe, expect, it } from "vitest";
import {
  passkeyAnonymousRateLimitScope,
  passkeyLoginRateLimits,
} from "../../src/auth/passkey-rate-limit";

describe("passkey rate-limit identities", () => {
  it("uses the authenticated project for project WS requests", () => {
    expect(passkeyAnonymousRateLimitScope({ projectKey: "project-a", ip: "203.0.113.7" }))
      .toBe("project:project-a");
    expect(passkeyLoginRateLimits("rotated@example.com", {
      projectKey: "project-a",
      ip: "198.51.100.9",
    }).map((r) => r.key)).toEqual(["passkey-login:project:project-a"]);
  });

  it("never limits REST login by the email alone", () => {
    const fromAttacker = passkeyLoginRateLimits("User@Example.com", { ip: "203.0.113.7" });
    const fromOwner = passkeyLoginRateLimits("user@example.com", { ip: "198.51.100.9" });
    expect(fromAttacker.map((r) => r.key)).toEqual([
      "passkey-login:ip:203.0.113.7",
      "passkey-login:account:user@example.com:ip:203.0.113.7",
    ]);
    // 攻撃者の接続元で枠を使い切っても、本人の接続元の枠とは共有しない。
    expect(fromOwner.map((r) => r.key).some((k) => fromAttacker.some((a) => a.key === k))).toBe(false);
  });

  it("limits usernameless login by the client IP", () => {
    expect(passkeyLoginRateLimits("", { ip: "203.0.113.7" }).map((r) => r.key))
      .toEqual(["passkey-login:ip:203.0.113.7"]);
    expect(passkeyAnonymousRateLimitScope({})).toBe("anon");
  });
});
