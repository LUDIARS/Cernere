import { describe, it, expect } from "vitest";
import { mergeWebauthnOrigins } from "../../src/auth/webauthn-origins";

describe("auth/webauthn-origins — mergeWebauthnOrigins", () => {
  it("keeps Cernere's own origins first and appends composite allowed origins", () => {
    expect(mergeWebauthnOrigins(
      ["http://localhost:5173"],
      ["http://localhost:5187", "https://app.example.com"],
    )).toEqual(["http://localhost:5173", "http://localhost:5187", "https://app.example.com"]);
  });

  it("normalises full URLs to their origin and de-duplicates", () => {
    expect(mergeWebauthnOrigins(
      ["https://cernere.example.com/login?x=1"],
      ["https://cernere.example.com", "https://app.example.com/cb"],
    )).toEqual(["https://cernere.example.com", "https://app.example.com"]);
  });

  it("drops unparseable and opaque entries instead of passing them to WebAuthn", () => {
    expect(mergeWebauthnOrigins(
      ["not a url", "javascript:alert(1)"],
      ["about:blank", "https://app.example.com"],
    )).toEqual(["https://app.example.com"]);
  });

  it("drops non-HTTP origins", () => {
    expect(mergeWebauthnOrigins(
      ["ftp://cernere.example.com"],
      ["wss://app.example.com", "https://app.example.com"],
    )).toEqual(["https://app.example.com"]);
  });

  it("returns an empty list when nothing is configured (fail-closed for verification)", () => {
    expect(mergeWebauthnOrigins([], [])).toEqual([]);
  });
});
