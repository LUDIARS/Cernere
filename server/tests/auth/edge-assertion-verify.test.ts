/**
 * エッジ認証のアサーション検証 (DB / Redis に触らない純粋な経路)。
 *
 * RSA 鍵はテスト内で生成し、 JWKS も fetch スタブで返す。 実際の Cloudflare には
 * 一切問い合わせない。
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";

import { verifyEdgeAssertion, EdgeAssertionError } from "../../src/auth/edge-assertion.js";
import { resetEdgeJwksCache } from "../../src/auth/edge-jwks.js";
import type { EdgeIdpBinding } from "../../src/project/edge-bindings.js";

const TEAM = "example.cloudflareaccess.com";
const AUD = "aud-tag-1";
const KID = "kid-1";
const NOW = 1_800_000_000_000;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherPair = generateKeyPairSync("rsa", { modulusLength: 2048 });

function binding(overrides: Partial<EdgeIdpBinding> = {}): EdgeIdpBinding {
  return {
    projectKey: "corp-hub",
    provider: "cf_access",
    teamDomain: TEAM,
    audTags: [AUD],
    subjectClaim: "sub",
    allowedEmailDomains: ["example.co.jp"],
    provisioning: "auto",
    defaultRole: "general",
    adminGroups: [],
    fetchIdentity: true,
    requireDeviceCheck: false,
    isActive: true,
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function sign(payload: Record<string, unknown>, key = privateKey): string {
  return jwt.sign(payload, key.export({ type: "pkcs8", format: "pem" }) as string, {
    algorithm: "RS256",
    keyid: KID,
  });
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const seconds = Math.floor(NOW / 1000);
  return {
    iss: `https://${TEAM}`,
    aud: [AUD],
    sub: "cf-user-1",
    email: "Taro@example.co.jp",
    iat: seconds - 10,
    exp: seconds + 3600,
    identity_nonce: "nonce-1",
    custom: { sub: "google-sub-1", name: "山田 太郎" },
    ...overrides,
  };
}

/** JWKS を返す fetch スタブ。 */
function jwksFetch(kid = KID, key = publicKey): typeof fetch {
  const jwk = { ...key.export({ format: "jwk" }), kid, use: "sig" };
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ keys: [jwk] }),
  } as unknown as Response) as unknown as typeof fetch;
}

async function expectReason(promise: Promise<unknown>, reason: string): Promise<void> {
  await expect(promise).rejects.toThrowError(EdgeAssertionError);
  await promise.catch((err: unknown) => {
    expect((err as EdgeAssertionError).reason).toBe(reason);
  });
}

describe("verifyEdgeAssertion", () => {
  beforeEach(() => {
    resetEdgeJwksCache();
  });

  it("accepts a well-formed assertion and normalises the email", async () => {
    const claims = await verifyEdgeAssertion(binding(), sign(validPayload()), {
      now: NOW,
      fetchImpl: jwksFetch(),
    });

    expect(claims.email).toBe("taro@example.co.jp");
    expect(claims.cfSub).toBe("cf-user-1");
    expect(claims.idpSubject).toBe("google-sub-1");
    expect(claims.identityNonce).toBe("nonce-1");
    expect(claims.customName).toBe("山田 太郎");
  });

  it("rejects an assertion signed by a different key", async () => {
    const forged = sign(validPayload(), otherPair.privateKey);

    await expectReason(
      verifyEdgeAssertion(binding(), forged, { now: NOW, fetchImpl: jwksFetch() }),
      "signature",
    );
  });

  it("rejects alg=none (unsigned) assertions", async () => {
    const unsigned = jwt.sign(validPayload(), "", { algorithm: "none", keyid: KID });

    await expectReason(
      verifyEdgeAssertion(binding(), unsigned, { now: NOW, fetchImpl: jwksFetch() }),
      "malformed",
    );
  });

  it("rejects an HS256 assertion even when the payload is otherwise valid", async () => {
    const hs = jwt.sign(validPayload(), "shared-secret", { algorithm: "HS256", keyid: KID });

    await expectReason(
      verifyEdgeAssertion(binding(), hs, { now: NOW, fetchImpl: jwksFetch() }),
      "malformed",
    );
  });

  it("rejects an aud that does not match the registered AUD tag", async () => {
    const wrongAud = sign(validPayload({ aud: ["someone-elses-app"] }));

    await expectReason(
      verifyEdgeAssertion(binding(), wrongAud, { now: NOW, fetchImpl: jwksFetch() }),
      "aud",
    );
  });

  it("accepts when one of several aud values matches", async () => {
    const multiAud = sign(validPayload({ aud: ["other-app", AUD] }));

    const claims = await verifyEdgeAssertion(binding(), multiAud, {
      now: NOW,
      fetchImpl: jwksFetch(),
    });

    expect(claims.email).toBe("taro@example.co.jp");
  });

  it("rejects an assertion from a different team domain (issuer)", async () => {
    const wrongIssuer = sign(validPayload({ iss: "https://evil.cloudflareaccess.com" }));

    await expectReason(
      verifyEdgeAssertion(binding(), wrongIssuer, { now: NOW, fetchImpl: jwksFetch() }),
      "issuer",
    );
  });

  it("rejects an expired assertion", async () => {
    const seconds = Math.floor(NOW / 1000);
    const expired = sign(validPayload({ iat: seconds - 7200, exp: seconds - 3600 }));

    await expectReason(
      verifyEdgeAssertion(binding(), expired, { now: NOW, fetchImpl: jwksFetch() }),
      "expired",
    );
  });

  it("tolerates 60 seconds of clock skew", async () => {
    const seconds = Math.floor(NOW / 1000);
    const justExpired = sign(validPayload({ iat: seconds - 3600, exp: seconds - 30 }));

    const claims = await verifyEdgeAssertion(binding(), justExpired, {
      now: NOW,
      fetchImpl: jwksFetch(),
    });

    expect(claims.email).toBe("taro@example.co.jp");
  });

  it("rejects service tokens (common_name present)", async () => {
    const serviceToken = sign(validPayload({ common_name: "ci-runner.access", sub: "" }));

    await expectReason(
      verifyEdgeAssertion(binding(), serviceToken, { now: NOW, fetchImpl: jwksFetch() }),
      "service_token",
    );
  });

  it("rejects assertions with an empty sub", async () => {
    const emptySub = sign(validPayload({ sub: "" }));

    await expectReason(
      verifyEdgeAssertion(binding(), emptySub, { now: NOW, fetchImpl: jwksFetch() }),
      "service_token",
    );
  });

  it("rejects an email outside the allow-listed domains", async () => {
    const outsider = sign(validPayload({ email: "someone@gmail.com" }));

    await expectReason(
      verifyEdgeAssertion(binding(), outsider, { now: NOW, fetchImpl: jwksFetch() }),
      "domain",
    );
  });

  it("does not treat a look-alike domain suffix as allowed", async () => {
    const lookalike = sign(validPayload({ email: "attacker@evil-example.co.jp" }));

    await expectReason(
      verifyEdgeAssertion(binding(), lookalike, { now: NOW, fetchImpl: jwksFetch() }),
      "domain",
    );
  });

  it("rejects an assertion with no email claim", async () => {
    const noEmail = sign(validPayload({ email: undefined }));

    await expectReason(
      verifyEdgeAssertion(binding(), noEmail, { now: NOW, fetchImpl: jwksFetch() }),
      "no_email",
    );
  });

  it("falls back to no idp_subject when the configured custom claim is absent", async () => {
    const withoutCustom = sign(validPayload({ custom: { name: "山田 太郎" } }));

    const claims = await verifyEdgeAssertion(binding(), withoutCustom, {
      now: NOW,
      fetchImpl: jwksFetch(),
    });

    expect(claims.idpSubject).toBeNull();
    expect(claims.email).toBe("taro@example.co.jp");
  });

  it("ignores custom claims entirely when the binding has no subject_claim", async () => {
    const claims = await verifyEdgeAssertion(
      binding({ subjectClaim: null }),
      sign(validPayload()),
      { now: NOW, fetchImpl: jwksFetch() },
    );

    expect(claims.idpSubject).toBeNull();
  });

  it("rejects (fail-closed) when the signing key cannot be resolved", async () => {
    const unreachable = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    await expectReason(
      verifyEdgeAssertion(binding(), sign(validPayload()), { now: NOW, fetchImpl: unreachable }),
      "signature",
    );
  });

  it("rejects a garbage assertion string", async () => {
    await expectReason(
      verifyEdgeAssertion(binding(), "not-a-jwt", { now: NOW, fetchImpl: jwksFetch() }),
      "malformed",
    );
  });
});
