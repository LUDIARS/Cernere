import { describe, expect, it } from "vitest";
import { publicPasskeyCompositeError } from "../../src/auth/passkey-public-error";

describe("publicPasskeyCompositeError", () => {
  it("preserves deliberate recovery guidance", () => {
    const error = new Error("Challenge expired or missing - please retry");
    expect(publicPasskeyCompositeError(error)).toBe(error);
  });

  it("suppresses unexpected persistence details", () => {
    const error = publicPasskeyCompositeError(
      new Error('duplicate key violates constraint "users_email_key" (private-canary)'),
    );
    expect(error.message).toBe("Passkey authentication failed");
    expect(error.message).not.toContain("private-canary");
  });
});
