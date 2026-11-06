import { describe, expect, it } from "vitest";
import { declaredCompositeOrigins, isCompositeOrigin } from "../../src/project/composite-origin-policy.js";

describe("administrator-owned Composite origins", () => {
  it("accepts only a complete canonical HTTPS origin in production", () => {
    expect(isCompositeOrigin("https://glab.example", "glab")).toBe(true);
    for (const origin of ["http://glab.example", "https://glab.example/", "https://glab.example/path", "https://a@glab.example", "https://*.example", "null", "https://localhost", "https://127.1", "https://[::1]"]) {
      expect(isCompositeOrigin(origin, "glab"), origin).toBe(false);
    }
  });
  it("limits HTTP and loopback exceptions to cernere-test in development", () => {
    expect(isCompositeOrigin("http://localhost:5173", "cernere-test", true)).toBe(true);
    expect(isCompositeOrigin("http://localhost:5173", "glab", true)).toBe(false);
    expect(isCompositeOrigin("http://localhost:5173", "cernere-test", false)).toBe(false);
  });
  it("fails closed on malformed stored declarations", () => {
    expect(declaredCompositeOrigins({ composite_origins: ["https://glab.example", "http://bad.example"] }, "glab")).toEqual([]);
    expect(declaredCompositeOrigins({ composite_origins: "https://glab.example" }, "glab")).toEqual([]);
  });
});
