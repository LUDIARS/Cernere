import { describe, expect, it } from "vitest";
import { passkeyLoginDecoy } from "../../src/auth/passkey-login-decoy";

describe("passkey login decoy", () => {
  it("is stable per email and secret", () => {
    expect(passkeyLoginDecoy("a@example.com", "s1")).toEqual(passkeyLoginDecoy(" A@Example.com ", "s1"));
  });

  it("differs per email and per secret", () => {
    const base = passkeyLoginDecoy("a@example.com", "s1")[0].id;
    expect(passkeyLoginDecoy("b@example.com", "s1")[0].id).not.toBe(base);
    expect(passkeyLoginDecoy("a@example.com", "s2")[0].id).not.toBe(base);
  });

  it("looks like a credential id (base64url, 32 bytes)", () => {
    const [decoy] = passkeyLoginDecoy("a@example.com", "s1");
    expect(decoy.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 本物の allowCredentials と同じく id だけを持つ (形の違いで登録有無を見分けさせない)。
    expect(Object.keys(decoy)).toEqual(["id"]);
  });
});
