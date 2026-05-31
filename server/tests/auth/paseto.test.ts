import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync } from "node:crypto";

// paseto.ts は import 時に loadKeys() が CERNERE_PASETO_* env を読むため、
// 鍵を生成して env に注入してから動的 import する。
type PasetoModule = typeof import("../../src/auth/paseto");
let paseto: PasetoModule;

const AUDIENCE = "https://hub.memoria.example.com";

beforeAll(async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // PKCS8 DER の先頭 16 byte は ASN.1 prefix。残り 32 byte が seed。
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const seed = pkcs8.subarray(pkcs8.length - 32);
  // SPKI DER の末尾 32 byte が raw public key。
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rawPub = spki.subarray(spki.length - 32);

  process.env.CERNERE_PASETO_SECRET_KEY = seed.toString("base64");
  process.env.CERNERE_PASETO_PUBLIC_KEY = rawPub.toString("base64");
  process.env.CERNERE_PASETO_KID = "test";

  paseto = await import("../../src/auth/paseto");
});

describe("auth/paseto — key loading", () => {
  it("is enabled when a valid keypair is provided", () => {
    expect(paseto.isPasetoEnabled()).toBe(true);
  });

  it("exposes the current public key via getPublicKeys()", () => {
    const keys = paseto.getPublicKeys();
    expect(keys.length).toBe(1);
    expect(keys[0].kid).toBe("test");
    expect(keys[0].alg).toBe("EdDSA");
    expect(keys[0].current).toBe(true);
  });
});

describe("auth/paseto — sign / verify", () => {
  it("round-trips a project token for the expected audience", async () => {
    const token = await paseto.signProjectToken({
      userId: "user-1",
      projectKey: "memoria",
      role: "general",
      displayName: "Alice",
      audience: AUDIENCE,
    });
    const claims = await paseto.verifyProjectTokenPaseto(token, AUDIENCE);
    expect(claims.sub).toBe("user-1");
    expect(claims.projectKey).toBe("memoria");
    expect(claims.role).toBe("general");
    expect(claims.kind).toBe("user_for_project");
    expect(claims.aud).toBe(AUDIENCE);
  });

  it("rejects a token presented to the wrong audience (confused deputy)", async () => {
    const token = await paseto.signProjectToken({
      userId: "user-1",
      projectKey: "memoria",
      role: "general",
      displayName: "Alice",
      audience: AUDIENCE,
    });
    await expect(
      paseto.verifyProjectTokenPaseto(token, "https://hub.other.example.com"),
    ).rejects.toThrow();
  });

  it("requires an expectedAudience (refuses to verify without one)", async () => {
    const token = await paseto.signProjectToken({
      userId: "user-1",
      projectKey: "memoria",
      role: "general",
      displayName: "Alice",
      audience: AUDIENCE,
    });
    await expect(paseto.verifyProjectTokenPaseto(token, "")).rejects.toThrow(/expectedAudience is required/);
  });

  it("rejects a tampered token", async () => {
    const token = await paseto.signProjectToken({
      userId: "user-1",
      projectKey: "memoria",
      role: "general",
      displayName: "Alice",
      audience: AUDIENCE,
    });
    const tampered = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
    await expect(paseto.verifyProjectTokenPaseto(tampered, AUDIENCE)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const token = await paseto.signProjectToken({
      userId: "user-1",
      projectKey: "memoria",
      role: "general",
      displayName: "Alice",
      audience: AUDIENCE,
      ttlSec: -1,
    });
    await expect(paseto.verifyProjectTokenPaseto(token, AUDIENCE)).rejects.toThrow();
  });
});
