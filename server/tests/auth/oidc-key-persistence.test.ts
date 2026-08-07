import { createPublicKey, generateKeyPairSync, type JsonWebKey } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createOidcKeyManager } from "../../src/auth/oidc-keys.js";
import type { OidcKeyRepository, OidcStoredSigningKey } from "../../src/auth/oidc-key-repository.js";
import { ID_TOKEN_TTL_SEC } from "../../src/oidc/scopes.js";

function storedKey(kid: string): OidcStoredSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    kid,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    isCurrent: true,
    createdAt: new Date(),
    retiredAt: null,
  };
}

function repository(overrides: Partial<OidcKeyRepository> = {}): OidcKeyRepository {
  return {
    findCurrent: vi.fn().mockResolvedValue(null),
    findRetiredSince: vi.fn().mockResolvedValue([]),
    insertCurrent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("OIDC DB signing keys", () => {
  it("uses the env key without reading the database", async () => {
    const envKey = storedKey("ignored");
    const repo = repository();
    const manager = createOidcKeyManager({
      repository: repo,
      environment: { CERNERE_OIDC_PRIVATE_KEY: envKey.privateKeyPem, CERNERE_OIDC_KID: "from-env" },
    });

    await manager.init();

    expect(manager.kid()).toBe("from-env");
    expect(repo.findCurrent).not.toHaveBeenCalled();
    expect(repo.insertCurrent).not.toHaveBeenCalled();
  });

  it("uses the current DB key without generating one", async () => {
    const current = storedKey("from-db");
    const repo = repository({ findCurrent: vi.fn().mockResolvedValue(current) });
    const manager = createOidcKeyManager({ repository: repo, environment: {} });

    await manager.init();

    expect(manager.kid()).toBe("from-db");
    expect(repo.insertCurrent).not.toHaveBeenCalled();
  });

  it("generates and persists a key when the database is empty", async () => {
    const repo = repository();
    const manager = createOidcKeyManager({ repository: repo, environment: {} });

    await manager.init();

    expect(manager.kid()).toMatch(/^oidc-[0-9a-f]{8}$/);
    expect(repo.insertCurrent).toHaveBeenCalledOnce();
  });

  it("adopts the concurrently inserted key after an insert collision", async () => {
    const concurrent = storedKey("concurrent");
    const repo = repository({
      findCurrent: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(concurrent),
      insertCurrent: vi.fn().mockRejectedValue(new Error("duplicate key")),
    });
    const manager = createOidcKeyManager({ repository: repo, environment: {} });

    await manager.init();

    expect(manager.kid()).toBe("concurrent");
  });

  it("publishes only retired keys newer than the id token TTL", async () => {
    const now = new Date("2026-08-04T00:00:00.000Z");
    const current = storedKey("current");
    const recent = { ...storedKey("recent"), isCurrent: false, retiredAt: new Date(now.getTime() - ID_TOKEN_TTL_SEC * 1000 + 1) };
    const boundary = { ...storedKey("boundary"), isCurrent: false, retiredAt: new Date(now.getTime() - ID_TOKEN_TTL_SEC * 1000) };
    const repo = repository({
      findCurrent: vi.fn().mockResolvedValue(current),
      findRetiredSince: vi.fn().mockImplementation(async (since: Date) => [recent, boundary].filter((key) => key.retiredAt! > since)),
    });
    const manager = createOidcKeyManager({ repository: repo, environment: {}, now: () => now });

    await manager.init();

    expect(manager.jwks().keys.map((key) => key.kid)).toEqual(["current", "recent"]);
  });

  it("stays enabled with the current key when the retired-key lookup fails", async () => {
    const repo = repository({
      findCurrent: vi.fn().mockResolvedValue(storedKey("current")),
      findRetiredSince: vi.fn().mockRejectedValue(new Error("connection reset")),
    });
    const manager = createOidcKeyManager({ repository: repo, environment: {} });

    await manager.init();

    expect(manager.isEnabled()).toBe(true);
    expect(manager.jwks().keys.map((key) => key.kid)).toEqual(["current"]);
  });

  it("skips an unusable retired key instead of failing startup", async () => {
    const broken = { ...storedKey("broken"), isCurrent: false, retiredAt: new Date(), privateKeyPem: "not-a-pem" };
    const repo = repository({
      findCurrent: vi.fn().mockResolvedValue(storedKey("current")),
      findRetiredSince: vi.fn().mockResolvedValue([broken]),
    });
    const manager = createOidcKeyManager({ repository: repo, environment: {} });

    await expect(manager.init()).resolves.toBeUndefined();

    expect(manager.isEnabled()).toBe(true);
    expect(manager.jwks().keys.map((key) => key.kid)).toEqual(["current"]);
  });

  it("derives the published public key from the private key, not the stored public column", async () => {
    // public_key_pem は暗号化も改竄検知もされない。 別鍵に差し替えられても
    // JWKS は署名鍵の public を公開しなければならない。
    const current = storedKey("current");
    const tampered = { ...current, publicKeyPem: storedKey("other").publicKeyPem };
    const repo = repository({ findCurrent: vi.fn().mockResolvedValue(tampered) });
    const manager = createOidcKeyManager({ repository: repo, environment: {} });

    await manager.init();

    const expected = createPublicKey({ key: current.privateKeyPem }).export({ format: "jwk" });
    const published: JsonWebKey = manager.jwks().keys[0];
    expect(published.n).toBe(expected.n);
    expect(published.n).not.toBe(createPublicKey({ key: tampered.publicKeyPem }).export({ format: "jwk" }).n);
  });

  it("keeps the retired DB key when the same kid is also listed in the env previous keys", async () => {
    const current = storedKey("current");
    const retired = { ...storedKey("rotated"), isCurrent: false, retiredAt: new Date() };
    const repo = repository({
      findCurrent: vi.fn().mockResolvedValue(current),
      findRetiredSince: vi.fn().mockResolvedValue([retired]),
    });
    const manager = createOidcKeyManager({
      repository: repo,
      environment: {
        CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS: `rotated:${Buffer.from(retired.publicKeyPem).toString("base64")}`,
      },
    });

    await expect(manager.init()).resolves.toBeUndefined();

    expect(manager.jwks().keys.map((key) => key.kid)).toEqual(["current", "rotated"]);
  });

  it("throws before initialization", () => {
    const manager = createOidcKeyManager({ repository: repository(), environment: {} });
    expect(() => manager.sign({ sub: "u1" }, 60)).toThrow("initOidcKeys() が未実行");
  });

  it("initializes only once", async () => {
    const repo = repository();
    const manager = createOidcKeyManager({ repository: repo, environment: {} });

    await manager.init();
    await manager.init();

    expect(repo.insertCurrent).toHaveBeenCalledOnce();
  });
});

describe("OIDC disabled configurations", () => {
  it("mode=off neither reads nor generates a key, and does not fail startup", async () => {
    const repo = repository();
    const manager = createOidcKeyManager({ repository: repo, environment: { CERNERE_OIDC_MODE: "off" } });

    await expect(manager.init()).resolves.toBeUndefined();

    expect(manager.isEnabled()).toBe(false);
    expect(manager.jwks().keys).toEqual([]);
    expect(repo.findCurrent).not.toHaveBeenCalled();
    expect(repo.insertCurrent).not.toHaveBeenCalled();
  });

  it("mode=off wins over a configured env key", async () => {
    const envKey = storedKey("ignored");
    const manager = createOidcKeyManager({
      repository: repository(),
      environment: { CERNERE_OIDC_MODE: "off", CERNERE_OIDC_PRIVATE_KEY: envKey.privateKeyPem },
    });

    await manager.init();

    expect(manager.isEnabled()).toBe(false);
  });

  it("stays disabled instead of failing startup when the key store is unreachable", async () => {
    const repo = repository({ findCurrent: vi.fn().mockRejectedValue(new Error("connection refused")) });
    const manager = createOidcKeyManager({ repository: repo, environment: {} });

    await expect(manager.init()).resolves.toBeUndefined();

    expect(manager.isEnabled()).toBe(false);
  });

  it("still fails loudly when an env key is present but unreadable", async () => {
    const manager = createOidcKeyManager({
      repository: repository(),
      environment: { CERNERE_OIDC_PRIVATE_KEY: "not-a-pem" },
    });

    await expect(manager.init()).rejects.toThrow();
  });

  it("rejects an unknown mode", async () => {
    const manager = createOidcKeyManager({ repository: repository(), environment: { CERNERE_OIDC_MODE: "maybe" } });

    await expect(manager.init()).rejects.toThrow('CERNERE_OIDC_MODE must be "auto" or "off"');
  });
});
