import { describe, expect, it, vi } from "vitest";

// project-resolver は db を import するが、ここで見るのは純粋関数だけ。
vi.mock("../../src/db/connection.js", () => ({ db: {} }));
import { buildConsentContinuation, completeContinuation } from "../../src/consent/continuation.js";
import { decideConsentGate } from "../../src/consent/gate-policy.js";
import { matchProjectByOrigin } from "../../src/consent/project-resolver.js";

const allowed = ["https://svc.example.com", "https://hub.example.com"];

describe("buildConsentContinuation — open redirect 防止", () => {
  it("許可 origin の redirect は完全 URL のまま (fragment は落とす)", () => {
    expect(buildConsentContinuation({ mode: "redirect", target: "https://svc.example.com/after?x=1#frag" }, allowed))
      .toEqual({ kind: "redirect", url: "https://svc.example.com/after?x=1" });
  });

  it("post_message は origin だけを残す", () => {
    expect(buildConsentContinuation({ mode: "post_message", target: "https://svc.example.com/path" }, allowed))
      .toEqual({ kind: "post_message", origin: "https://svc.example.com" });
  });

  it.each([
    "https://evil.example.com/steal",
    "https://svc.example.com.evil.com/",
    "javascript:alert(1)",
    "data:text/html,hi",
    "https://user:pass@svc.example.com/",
    "//svc.example.com/",
    "not a url",
  ])("許可外・不正な送り先 %s は継続先にしない", (target) => {
    expect(buildConsentContinuation({ mode: "redirect", target }, allowed)).toBeNull();
  });
});

describe("completeContinuation", () => {
  it("許可: redirect は ?code=、post_message は authCode を載せる", () => {
    expect(completeContinuation({ kind: "redirect", url: "https://svc.example.com/a?x=1" }, { authCode: "abc" }))
      .toEqual({ kind: "redirect", url: "https://svc.example.com/a?x=1&code=abc" });
    expect(completeContinuation({ kind: "post_message", origin: "https://svc.example.com" }, { authCode: "abc" }))
      .toEqual({ kind: "post_message", origin: "https://svc.example.com", message: { type: "cernere:auth", authCode: "abc" } });
  });

  it("拒否: サービスへ consent_denied を返す", () => {
    expect(completeContinuation({ kind: "redirect", url: "https://svc.example.com/" }, { denied: true }))
      .toEqual({ kind: "redirect", url: "https://svc.example.com/?error=consent_denied" });
    expect(completeContinuation({ kind: "post_message", origin: "https://svc.example.com" }, { denied: true }))
      .toEqual({ kind: "post_message", origin: "https://svc.example.com", message: { type: "cernere:auth", error: "consent_denied" } });
  });

  it("authCode を出さない許可 (edge) は継続先へ戻すだけ / 継続先が無ければ none", () => {
    expect(completeContinuation({ kind: "redirect", url: "https://hub.example.com/" }, { authCode: null }))
      .toEqual({ kind: "redirect", url: "https://hub.example.com/" });
    expect(completeContinuation(null, { authCode: "abc" })).toEqual({ kind: "none" });
  });
});

describe("decideConsentGate — consent_mode", () => {
  it.each([
    ["off", false, "pass"],
    ["off", true, "pass"],
    ["warn", false, "warn"],
    ["warn", true, "pass"],
    ["enforce", false, "block"],
    ["enforce", true, "pass"],
  ] as const)("%s / satisfied=%s → %s", (mode, satisfied, expected) => {
    expect(decideConsentGate(mode, satisfied)).toBe(expected);
  });
});

describe("matchProjectByOrigin — target origin → frontend_url で逆引き", () => {
  const projects = [
    { key: "zeta", frontendUrl: "https://svc.example.com/app" },
    { key: "alpha", frontendUrl: "https://svc.example.com" },
    { key: "other", frontendUrl: "https://other.example.com" },
    { key: "none", frontendUrl: null },
  ];

  it("origin が一致する project を返す (path は見ない、複数一致は key 昇順の先頭)", () => {
    expect(matchProjectByOrigin(projects, "https://svc.example.com/callback?x=1")).toBe("alpha");
    expect(matchProjectByOrigin(projects, "https://other.example.com")).toBe("other");
  });

  it("一致しない・不正な target は null", () => {
    expect(matchProjectByOrigin(projects, "https://unknown.example.com")).toBeNull();
    expect(matchProjectByOrigin(projects, "javascript:alert(1)")).toBeNull();
  });
});
