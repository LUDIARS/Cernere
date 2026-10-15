import { describe, expect, it } from "vitest";
import { AUTH_CODE_AUDIENCE_MISMATCH, checkExchangeAudience } from "../../src/auth/auth-code-audience.js";

describe("checkExchangeAudience (authCode の用途と交換元)", () => {
  it("Cernere 用の code を Cernere の画面から交換するのは通す", () => {
    expect(checkExchangeAudience("cernere", true)).toBeNull();
  });

  it("Cernere 用の code をサービス等から交換したら、許可待ちではなく用途違いを返す", () => {
    const result = checkExchangeAudience("cernere", false);
    expect(result?.code).toBe(AUTH_CODE_AUDIENCE_MISMATCH);
    expect(result?.code).not.toBe("approval_required");
    expect(result?.message).toContain("FRONTEND_URL");
  });

  it("サービス向けと旧形式 (用途なし) の code はここでは止めない", () => {
    expect(checkExchangeAudience("service", false)).toBeNull();
    expect(checkExchangeAudience(undefined, false)).toBeNull();
  });
});
