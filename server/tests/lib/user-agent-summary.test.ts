import { describe, expect, it } from "vitest";
import { summarizeUserAgent } from "../../src/lib/user-agent-summary";

describe("summarizeUserAgent", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "Safari / iPhone"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0", "Edge / Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "Chrome / Windows"],
    ["Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36", "Chrome / Android"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox / macOS"],
  ])("summarizes %s", (ua, expected) => {
    expect(summarizeUserAgent(ua)).toBe(expected);
  });

  it("falls back for missing or unknown agents", () => {
    expect(summarizeUserAgent(undefined)).toBe("Unknown device");
    expect(summarizeUserAgent("curl/8.0")).toBe("Unknown device");
  });

  it("caps the length", () => {
    expect(summarizeUserAgent(`Chrome/1 ${"x".repeat(500)}`).length).toBeLessThanOrEqual(64);
  });
});
