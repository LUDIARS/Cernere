import { describe, expect, it } from "vitest";
import {
  passkeyAnonymousRateLimitScope,
  passkeyLoginRateLimits,
} from "../../src/auth/passkey-rate-limit";

describe("passkey rate-limit identities", () => {
  it("uses the authenticated project for project WS requests", () => {
    expect(passkeyAnonymousRateLimitScope({ projectKey: "project-a", ip: "203.0.113.7" }))
      .toBe("project:project-a");
  });

  it("gives a project a large shared budget and splits it per client hint", () => {
    const withoutHint = passkeyLoginRateLimits("rotated@example.com", { projectKey: "project-a", ip: "198.51.100.9" });
    expect(withoutHint).toEqual([{ key: "passkey-login:project:project-a", max: 3000, windowSecs: 900 }]);
    const withHint = passkeyLoginRateLimits("", { projectKey: "project-a", clientHint: "2001:db8:1:2::/64" });
    expect(withHint.map((r) => [r.key, r.max])).toEqual([
      ["passkey-login:project:project-a", 3000],
      ["passkey-login:project:project-a:client:2001:db8:1:2::/64", 30],
    ]);
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

  it("counts an IPv6 /64 as one client", () => {
    const a = passkeyLoginRateLimits("", { ip: "2001:db8:1:2::1" }).map((r) => r.key);
    const b = passkeyLoginRateLimits("", { ip: "2001:db8:1:2:ffff::9" }).map((r) => r.key);
    expect(a).toEqual(["passkey-login:ip:2001:db8:1:2::/64"]);
    expect(b).toEqual(a);
    expect(passkeyAnonymousRateLimitScope({})).toBe("anon");
  });
});
