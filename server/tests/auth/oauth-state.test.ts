import { describe, expect, it } from "vitest";
import {
  isLinkStateToken,
  createLinkStateToken,
  verifyOAuthStateParam,
} from "../../src/auth/oauth-state.js";

describe("verifyOAuthStateParam", () => {
  it("accepts a state that matches the csrf cookie", () => {
    const result = verifyOAuthStateParam({ stateParam: "abc", cookieState: "abc" });
    expect(result.ok).toBe(true);
  });

  it("rejects a mismatched state", () => {
    expect(verifyOAuthStateParam({ stateParam: "abc", cookieState: "zzz" }).ok).toBe(false);
  });

  it("rejects a missing state parameter", () => {
    expect(verifyOAuthStateParam({ stateParam: "", cookieState: "abc" }).ok).toBe(false);
  });

  it("rejects a missing cookie even when a state parameter is present", () => {
    expect(verifyOAuthStateParam({ stateParam: "abc", cookieState: undefined }).ok).toBe(false);
  });

  it("never carries a user id in the state itself", () => {
    const result = verifyOAuthStateParam({ stateParam: "link:user-123", cookieState: "link:user-123" });
    expect((result as Record<string, unknown>).userId).toBeUndefined();
  });
});

describe("link state marker", () => {
  it("marks states minted for a link", () => {
    expect(isLinkStateToken(createLinkStateToken("d9a1c0e2-0000-4000-8000-000000000000"))).toBe(true);
  });

  // 目印は state 本体と一体なので、 CSRF cookie との厳密一致検査をすり抜けない。
  it("keeps the marker inside the value compared against the csrf cookie", () => {
    const state = createLinkStateToken("d9a1c0e2-0000-4000-8000-000000000000");
    expect(verifyOAuthStateParam({ stateParam: state, cookieState: state }).ok).toBe(true);
    expect(verifyOAuthStateParam({ stateParam: state, cookieState: "d9a1c0e2-0000-4000-8000-000000000000" }).ok).toBe(false);
  });

  it("does not mark ordinary login or composite states", () => {
    expect(isLinkStateToken("d9a1c0e2-0000-4000-8000-000000000000")).toBe(false);
    expect(isLinkStateToken("composite:https://example.com:d9a1c0e2")).toBe(false);
    expect(isLinkStateToken(null)).toBe(false);
  });

  // 目印は権限を持たない。user id らしい文字列でも marker 判定しか行わない。
  it("treats a forged marker as only a marker", () => {
    expect(isLinkStateToken("link:victim-user-id")).toBe(true);
  });
});
