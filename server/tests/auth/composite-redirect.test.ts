import { describe, it, expect } from "vitest";
import { isOriginAllowed } from "../../src/auth/composite-redirect";

const ALLOW = ["https://app.example.com", "http://localhost:5173"];

describe("auth/composite-redirect — isOriginAllowed", () => {
  it("allows an exact origin string match", () => {
    expect(isOriginAllowed("https://app.example.com", ALLOW)).toBe(true);
    expect(isOriginAllowed("http://localhost:5173", ALLOW)).toBe(true);
  });

  it("allows a full URL whose origin is allowlisted (path/query/fragment ignored)", () => {
    expect(isOriginAllowed("https://app.example.com/cb?code=x#frag", ALLOW)).toBe(true);
  });

  it("rejects a non-allowlisted origin (token exfil target)", () => {
    expect(isOriginAllowed("https://evil.example", ALLOW)).toBe(false);
    expect(isOriginAllowed("https://app.example.com.evil.com", ALLOW)).toBe(false);
  });

  it("rejects scheme/port mismatches (exact origin, no coercion)", () => {
    expect(isOriginAllowed("http://app.example.com", ALLOW)).toBe(false); // https 登録に http
    expect(isOriginAllowed("https://app.example.com:8443", ALLOW)).toBe(false); // 別ポート
  });

  it("rejects opaque / dangerous schemes", () => {
    expect(isOriginAllowed("javascript:alert(1)", ALLOW)).toBe(false);
    expect(isOriginAllowed("data:text/html,x", ALLOW)).toBe(false);
    expect(isOriginAllowed("about:blank", ALLOW)).toBe(false);
  });

  it("rejects empty / unparseable / nullish targets", () => {
    expect(isOriginAllowed("", ALLOW)).toBe(false);
    expect(isOriginAllowed(null, ALLOW)).toBe(false);
    expect(isOriginAllowed(undefined, ALLOW)).toBe(false);
    expect(isOriginAllowed("not a url", ALLOW)).toBe(false);
  });

  it("rejects everything when the allowlist is empty (fail-closed)", () => {
    expect(isOriginAllowed("https://app.example.com", [])).toBe(false);
  });
});
