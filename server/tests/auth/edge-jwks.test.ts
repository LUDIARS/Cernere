/**
 * Cloudflare Access JWKS のキャッシュとレート制限。
 *
 * fetch はすべてスタブする (実際の Cloudflare には問い合わせない)。
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

import { getEdgeSigningKey, resetEdgeJwksCache } from "../../src/auth/edge-jwks.js";

const TEAM = "example.cloudflareaccess.com";

function jwkFor(kid: string): Record<string, unknown> {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { ...publicKey.export({ format: "jwk" }), kid, use: "sig" };
}

function jwksResponse(keys: Record<string, unknown>[]): Response {
  return { ok: true, json: async () => ({ keys }) } as unknown as Response;
}

describe("getEdgeSigningKey", () => {
  beforeEach(() => {
    resetEdgeJwksCache();
  });

  it("fetches the JWKS once and serves later lookups from cache", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jwksResponse([jwkFor("kid-1")]));

    const first = await getEdgeSigningKey(TEAM, "kid-1", 1_000, fetchImpl as unknown as typeof fetch);
    const second = await getEdgeSigningKey(TEAM, "kid-1", 2_000, fetchImpl as unknown as typeof fetch);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(`https://${TEAM}/cdn-cgi/access/certs`);
  });

  it("refreshes when an unknown kid appears (key rotation)", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jwksResponse([jwkFor("kid-1")]))
      .mockResolvedValueOnce(jwksResponse([jwkFor("kid-1"), jwkFor("kid-2")]));

    await getEdgeSigningKey(TEAM, "kid-1", 0, fetchImpl as unknown as typeof fetch);
    // 60 秒以上あけて未知 kid を引くと再取得する。
    const rotated = await getEdgeSigningKey(TEAM, "kid-2", 61_000, fetchImpl as unknown as typeof fetch);

    expect(rotated).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rate-limits forced refreshes to one per minute for unknown kids", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jwksResponse([jwkFor("kid-1")]));

    await getEdgeSigningKey(TEAM, "kid-1", 0, fetchImpl as unknown as typeof fetch);
    // 未知 kid を連打しても CF への問い合わせは増えない。
    for (let i = 0; i < 5; i += 1) {
      const key = await getEdgeSigningKey(TEAM, "unknown", 1_000 + i, fetchImpl as unknown as typeof fetch);
      expect(key).toBeNull();
    }

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the cached key when a later fetch fails", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jwksResponse([jwkFor("kid-1")]))
      .mockRejectedValue(new Error("network down"));

    const cached = await getEdgeSigningKey(TEAM, "kid-1", 0, fetchImpl as unknown as typeof fetch);
    // キャッシュ期限 (6h) を過ぎて取得に失敗しても、 既知 kid はキャッシュで通す。
    const afterExpiry = await getEdgeSigningKey(
      TEAM,
      "kid-1",
      7 * 60 * 60 * 1000,
      fetchImpl as unknown as typeof fetch,
    );

    expect(cached).not.toBeNull();
    expect(afterExpiry).not.toBeNull();
  });

  it("returns null (fail-closed) when there is neither cache nor a successful fetch", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

    const key = await getEdgeSigningKey(TEAM, "kid-1", 0, fetchImpl as unknown as typeof fetch);

    expect(key).toBeNull();
  });

  it("ignores non-RSA and encryption-only keys", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jwksResponse([
      { kty: "EC", kid: "ec-key", crv: "P-256", x: "abc", y: "def" },
      { ...jwkFor("enc-key"), use: "enc" },
      jwkFor("sig-key"),
    ]));

    const ec = await getEdgeSigningKey(TEAM, "ec-key", 0, fetchImpl as unknown as typeof fetch);
    const enc = await getEdgeSigningKey(TEAM, "enc-key", 10, fetchImpl as unknown as typeof fetch);
    const sig = await getEdgeSigningKey(TEAM, "sig-key", 20, fetchImpl as unknown as typeof fetch);

    expect(ec).toBeNull();
    expect(enc).toBeNull();
    expect(sig).not.toBeNull();
  });

  it("returns null when the JWKS response is not ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 } as unknown as Response);

    const key = await getEdgeSigningKey(TEAM, "kid-1", 0, fetchImpl as unknown as typeof fetch);

    expect(key).toBeNull();
  });
});
