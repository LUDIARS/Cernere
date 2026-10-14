import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  digestRecoverySecret,
  formatRecoveryCode,
  loadRecoveryCodeKey,
  parseRecoveryCode,
} from "../../src/auth/recovery-code";

const id = randomBytes(16).toString("base64url");
const secret = randomBytes(32).toString("base64url");
const key = randomBytes(32);

describe("recovery code format (SPEC-RECOVERY-QR)", () => {
  it("round-trips the QR payload without carrying a userId", () => {
    const code = formatRecoveryCode(id, secret);
    expect(code.startsWith("CRRC1.")).toBe(true);
    expect(parseRecoveryCode(code)).toEqual({ recoveryId: id, secret });
  });

  it.each([
    ["wrong prefix", `CRRC0.${id}.${secret}`],
    ["missing secret", `CRRC1.${id}`],
    ["extra part", `CRRC1.${id}.${secret}.x`],
    ["short id", `CRRC1.${randomBytes(8).toString("base64url")}.${secret}`],
    ["short secret", `CRRC1.${id}.${randomBytes(16).toString("base64url")}`],
    ["non base64url", `CRRC1.${id}.${secret.slice(0, -1)}+`],
    ["too long", `CRRC1.${"a".repeat(300)}`],
  ])("rejects %s", (_label, code) => {
    expect(parseRecoveryCode(code)).toBeNull();
  });

  it("binds the digest to the key, the id and the secret", () => {
    const base = digestRecoverySecret(key, id, secret);
    expect(digestRecoverySecret(key, id, secret)).toBe(base);
    expect(digestRecoverySecret(randomBytes(32), id, secret)).not.toBe(base);
    expect(digestRecoverySecret(key, randomBytes(16).toString("base64url"), secret)).not.toBe(base);
    expect(digestRecoverySecret(key, id, randomBytes(32).toString("base64url"))).not.toBe(base);
  });

  it("length-prefixes the parts so shifted boundaries do not collide", () => {
    expect(digestRecoverySecret(key, "ab", "c")).not.toBe(digestRecoverySecret(key, "a", "bc"));
  });
});

describe("loadRecoveryCodeKey", () => {
  it("fails fast when the key is missing instead of degrading", () => {
    expect(() => loadRecoveryCodeKey({})).toThrow(/CERNERE_RECOVERY_CODE_KEY/);
    expect(() => loadRecoveryCodeKey({ CERNERE_RECOVERY_CODE_KEY: key.toString("base64url") })).toThrow();
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => loadRecoveryCodeKey({
      CERNERE_RECOVERY_CODE_KEY: randomBytes(16).toString("base64url"),
      CERNERE_RECOVERY_CODE_KEY_ID: "k1",
    })).toThrow(/32 bytes/);
  });

  it("loads a valid key", () => {
    const loaded = loadRecoveryCodeKey({ CERNERE_RECOVERY_CODE_KEY: key.toString("base64url"), CERNERE_RECOVERY_CODE_KEY_ID: "k1" });
    expect(loaded.keyId).toBe("k1");
    expect(loaded.key.equals(key)).toBe(true);
  });
});
