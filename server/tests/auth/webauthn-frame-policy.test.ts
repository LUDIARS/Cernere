import { describe, expect, it } from "vitest";
import { assertWebauthnFrameAllowed } from "../../src/auth/webauthn-frame-policy.js";
const encode = (data: object) => Buffer.from(JSON.stringify(data)).toString("base64url");
const allowed = ["https://glab.example"];
describe("WebAuthn embedding boundary", () => {
  it("keeps top-level ceremonies", () => {
    expect(() => assertWebauthnFrameAllowed(encode({ crossOrigin: false }), allowed)).not.toThrow();
    expect(() => assertWebauthnFrameAllowed(encode({}), allowed)).not.toThrow();
  });
  it("accepts the exact allowed signed top origin", () => {
    expect(() => assertWebauthnFrameAllowed(encode({ crossOrigin: true, topOrigin: allowed[0] }), allowed)).not.toThrow();
  });
  it("supports Level 2 clients without topOrigin under the hosted frame policy", () => {
    expect(() => assertWebauthnFrameAllowed(encode({ crossOrigin: true }), allowed, true)).not.toThrow();
    expect(() => assertWebauthnFrameAllowed(encode({ crossOrigin: true }), allowed)).toThrow();
    expect(() => assertWebauthnFrameAllowed(encode({ crossOrigin: true }), [])).toThrow();
  });
  it.each([null, 12, "https://evil.example", "https://glab.example/path", "null"])("rejects invalid or untrusted topOrigin %s", topOrigin => {
    expect(() => assertWebauthnFrameAllowed(encode({ crossOrigin: true, topOrigin }), allowed)).toThrow();
  });
  it("fails closed without an embedding allowlist", () => {
    expect(() => assertWebauthnFrameAllowed(encode({ crossOrigin: true, topOrigin: allowed[0] }), [])).toThrow();
  });
});
