import { describe, expect, it } from "vitest";
import {
  passkeyAnonymousRateLimitScope,
  passkeyLoginRateLimitScope,
} from "../../src/auth/passkey-rate-limit";

describe("passkey rate-limit identities", () => {
  it("uses the authenticated project for project WS requests", () => {
    expect(passkeyAnonymousRateLimitScope({ projectKey: "project-a", ip: "203.0.113.7" }))
      .toBe("project:project-a");
    expect(passkeyLoginRateLimitScope("rotated@example.com", {
      projectKey: "project-a",
      ip: "198.51.100.9",
    })).toBe("project:project-a");
  });

  it("keeps direct REST requests scoped by account or server-observed IP", () => {
    expect(passkeyLoginRateLimitScope("user@example.com", { ip: "203.0.113.7" }))
      .toBe("user@example.com");
    expect(passkeyLoginRateLimitScope("", { ip: "203.0.113.7" }))
      .toBe("203.0.113.7");
    expect(passkeyAnonymousRateLimitScope({})).toBe("anon");
  });
});
