import { describe, expect, it } from "vitest";
import { redactSensitive } from "../../src/lib/redact.js";

describe("redactSensitive", () => {
  it("masks token / secret / password keys at the top level", () => {
    const out = redactSensitive({
      userId: "u1",
      provider: "google",
      accessToken: "ya29.secret",
      refreshToken: "1//0secret",
      password: "hunter2",
      clientSecret: "shh",
    }) as Record<string, unknown>;
    expect(out.userId).toBe("u1");
    expect(out.provider).toBe("google");
    expect(out.accessToken).toBe("[REDACTED]");
    expect(out.refreshToken).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
    expect(out.clientSecret).toBe("[REDACTED]");
  });

  it("masks sensitive keys nested in objects and arrays", () => {
    const out = redactSensitive({
      meta: { nested: { api_key: "abc", note: "keep" } },
      list: [{ token: "t1" }, { ok: "v" }],
    }) as any;
    expect(out.meta.nested.api_key).toBe("[REDACTED]");
    expect(out.meta.nested.note).toBe("keep");
    expect(out.list[0].token).toBe("[REDACTED]");
    expect(out.list[1].ok).toBe("v");
  });

  it("does not mutate the input", () => {
    const input = { accessToken: "x", keep: "y" };
    const out = redactSensitive(input) as Record<string, unknown>;
    expect(input.accessToken).toBe("x");
    expect(out.accessToken).toBe("[REDACTED]");
  });

  it("passes through non-sensitive primitives unchanged", () => {
    expect(redactSensitive("hello")).toBe("hello");
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(null)).toBeNull();
  });
});
