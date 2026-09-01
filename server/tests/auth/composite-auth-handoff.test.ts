import { describe, expect, it } from "vitest";
import { resolveSelfRedirectTarget } from "../../../frontend/src/lib/composite-auth-handoff";

const ORIGIN = "https://cernere.example";

describe("resolveSelfRedirectTarget", () => {
  it("keeps local paths, queries, and fragments", () => {
    expect(resolveSelfRedirectTarget("/profile?tab=security#passkeys", ORIGIN))
      .toBe("/profile?tab=security#passkeys");
  });

  it.each([
    "//evil.example/path",
    "/\\evil.example/path",
    "https://evil.example/path",
    "profile",
  ])("rejects a redirect that resolves outside the current origin: %s", (target) => {
    expect(resolveSelfRedirectTarget(target, ORIGIN)).toBe("/");
  });
});
