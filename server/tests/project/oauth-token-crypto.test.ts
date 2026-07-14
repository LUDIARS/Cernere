import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { _resetKeyCacheForTest } from "../../src/lib/crypto/secret-box.js";
import { encryptToken, decryptToken } from "../../src/project/oauth-token-crypto.js";

const KEY_HEX = randomBytes(32).toString("hex");

describe("oauth-token-crypto", () => {
  beforeEach(() => {
    process.env.CERNERE_SECRET_KEY = KEY_HEX;
    _resetKeyCacheForTest();
  });
  afterEach(() => {
    delete process.env.CERNERE_SECRET_KEY;
    _resetKeyCacheForTest();
  });

  it("encrypts a token so the plaintext is not stored verbatim", () => {
    const token = "ya29.a0AfH6S-some-google-access-token";
    const enc = encryptToken(token)!;
    expect(enc).not.toContain(token);
    expect(enc.startsWith("v1:")).toBe(true);
  });

  it("roundtrips access/refresh tokens through encrypt → decrypt", () => {
    for (const t of ["ya29.access", "1//0refresh", "日本語トークン"]) {
      expect(decryptToken(encryptToken(t))).toBe(t);
    }
  });

  it("passes null / undefined through (column stays NULL)", () => {
    expect(encryptToken(null)).toBeNull();
    expect(encryptToken(undefined)).toBeNull();
    expect(decryptToken(null)).toBeNull();
    expect(decryptToken(undefined)).toBeNull();
  });

  it("treats legacy non-v1 values as plaintext (lazy migration on read)", () => {
    // 暗号化導入前に平文で書かれた既存行
    expect(decryptToken("legacy-plaintext-refresh-token")).toBe("legacy-plaintext-refresh-token");
  });

  it("throws (fail-closed) when the key is unset", () => {
    delete process.env.CERNERE_SECRET_KEY;
    _resetKeyCacheForTest();
    expect(() => encryptToken("x")).toThrow(/CERNERE_SECRET_KEY/);
  });
});
