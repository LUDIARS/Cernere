import { describe, expect, it } from "vitest";
import { LOGIN_METHOD_RETIRED_ERROR, retiredLoginError, retiredLoginResult } from "../../src/auth/retired-login";
import { publicPasskeyCompositeError } from "../../src/auth/passkey-public-error";

describe("retired login methods (SPEC-LEGACY-LOGIN-RETIRED)", () => {
  it("answers 410 with a machine-readable code and the method", () => {
    const result = retiredLoginResult("password");
    expect(result.status).toBe("410 Gone");
    expect(result.data).toMatchObject({ error: LOGIN_METHOD_RETIRED_ERROR, method: "password" });
  });

  it("throws a 410 AppError for WS paths", () => {
    const error = retiredLoginError("google");
    expect(error.statusCode).toBe(410);
    expect(error.message).toContain("passkey");
  });

  it("keeps the popup guidance visible across the project WS boundary", () => {
    const error = new Error("Create the account in the Cernere sign-in window");
    expect(publicPasskeyCompositeError(error)).toBe(error);
  });
});
