import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  _resetKeyCacheForTest,
  decryptSecret,
  encryptSecret,
  encryptSecretNullable,
} from "../../../src/lib/crypto/secret-box.js";

const KEY_HEX = randomBytes(32).toString("hex");

describe("secret-box", () => {
  beforeEach(() => {
    process.env.CERNERE_SECRET_KEY = KEY_HEX;
    _resetKeyCacheForTest();
  });
  afterEach(() => {
    delete process.env.CERNERE_SECRET_KEY;
    _resetKeyCacheForTest();
  });

  it("roundtrips plaintext", () => {
    const secret = "ya29.a0AfH6S-google-oauth-access-token";
    const enc = encryptSecret(secret);
    expect(enc).not.toContain(secret);
    expect(enc.startsWith("v1:")).toBe(true);
    expect(decryptSecret(enc)).toBe(secret);
  });

  it("produces a distinct ciphertext per call (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("handles unicode / empty strings", () => {
    for (const s of ["", "日本語シークレット", "🔐"]) {
      expect(decryptSecret(encryptSecret(s))).toBe(s);
    }
  });

  it("treats non-v1 values as legacy plaintext (migration shim)", () => {
    expect(decryptSecret("legacy-plaintext-token")).toBe("legacy-plaintext-token");
  });

  it("detects tampering via the GCM auth tag", () => {
    const enc = encryptSecret("tamper-me");
    const parts = enc.split(":");
    // flip a byte in the ciphertext
    const ct = Buffer.from(parts[3], "base64url");
    ct[0] ^= 0xff;
    parts[3] = ct.toString("base64url");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("throws when the key is unset (fail-closed, no plaintext fallback)", () => {
    delete process.env.CERNERE_SECRET_KEY;
    _resetKeyCacheForTest();
    expect(() => encryptSecret("x")).toThrow(/CERNERE_SECRET_KEY/);
  });

  it("encryptSecretNullable passes through null/undefined", () => {
    expect(encryptSecretNullable(null)).toBeNull();
    expect(encryptSecretNullable(undefined)).toBeNull();
    expect(decryptSecret(encryptSecretNullable("v")!)).toBe("v");
  });
});
