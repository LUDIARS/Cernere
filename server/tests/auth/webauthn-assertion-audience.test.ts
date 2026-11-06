import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { verifyAuthenticationResponse } from "../../src/auth/verify-embedded-webauthn.js";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../src/config.js", () => ({ config: { webauthnOrigins: ["https://cr.example"], webauthnRpName: "Cr", webauthnRpId: "example" } }));
vi.mock("../../src/auth/composite-redirect.js", () => ({ compositeAllowedOrigins: async () => ["https://a.example", "https://b.example"] }));
import { assertionOrigins } from "../../src/auth/webauthn-policy.js";

// Real signatures using the existing verifier and its public CBOR helper.
function assertion(origin: string, embedding: { crossOrigin: true; topOrigin?: string } | { crossOrigin: false } = { crossOrigin: false }) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = new Map<number, number | Uint8Array>([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")],
  ]);
  const challenge = randomBytes(32).toString("base64url");
  const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, ...embedding }));
  const authenticatorData = Buffer.concat([createHash("sha256").update("example").digest(), Buffer.from([5, 0, 0, 0, 1])]);
  const signature = sign("sha256", Buffer.concat([authenticatorData, createHash("sha256").update(clientData).digest()]), privateKey);
  const id = randomBytes(32).toString("base64url");
  const response: AuthenticationResponseJSON = { id, rawId: id, type: "public-key", clientExtensionResults: {},
    response: { authenticatorData: authenticatorData.toString("base64url"), clientDataJSON: clientData.toString("base64url"), signature: signature.toString("base64url") } };
  return { response, expectedChallenge: challenge, expectedRPID: "example", requireUserVerification: true,
    credential: { id, publicKey: isoCBOR.encode(cose), counter: 0 } };
}

describe("authenticator-signed origin follows the challenge destination", () => {
  it("rejects a real service assertion for global/self completion", async () => {
    await expect(verifyAuthenticationResponse({ ...assertion("https://b.example"), expectedOrigin: assertionOrigins("cernere") })).rejects.toThrow();
  });
  it("rejects project B's signed assertion for project A", async () => {
    await expect(verifyAuthenticationResponse({ ...assertion("https://b.example"), expectedOrigin: assertionOrigins("service", { origin: "https://a.example" }) })).rejects.toThrow();
  });
  it.each(["service", "kiosk"] as const)("accepts only the matching project's origin for %s", async audience => {
    const result = await verifyAuthenticationResponse({ ...assertion("https://a.example"), expectedOrigin: assertionOrigins(audience, { origin: "https://a.example" }) });
    expect(result.verified).toBe(true);
  });
  it("keeps the Cr hosted ceremony for self and service", async () => {
    for (const origins of [assertionOrigins("cernere"), assertionOrigins("service", { origin: "https://a.example", ceremonyOrigin: "https://cr.example" })]) {
      expect((await verifyAuthenticationResponse({ ...assertion("https://cr.example"), expectedOrigin: origins })).verified).toBe(true);
    }
  });
  it("does not accept another project's HTTP origin as the ceremony origin", () => {
    expect(() => assertionOrigins("service", { origin: "https://a.example", ceremonyOrigin: "https://b.example" })).toThrow();
    expect(() => assertionOrigins("legacy" as never)).toThrow("Unknown");
  });
  it("still requires the original signed challenge", async () => {
    await expect(verifyAuthenticationResponse({ ...assertion("https://cr.example"), expectedOrigin: assertionOrigins("cernere"), expectedChallenge: "changed-challenge" })).rejects.toThrow();
  });
  it("rejects a Cr iframe for A embedded by B even when B is registered", async () => {
    await expect(verifyAuthenticationResponse({ ...assertion("https://cr.example", { crossOrigin: true, topOrigin: "https://b.example" }),
      expectedOrigin: assertionOrigins("service", { origin: "https://a.example", ceremonyOrigin: "https://cr.example" }) }, ["https://a.example"])).rejects.toThrow("embedding origin");
  });
  it("keeps a Cr iframe embedded by its destination", async () => {
    expect((await verifyAuthenticationResponse({ ...assertion("https://cr.example", { crossOrigin: true, topOrigin: "https://a.example" }),
      expectedOrigin: ["https://cr.example"] }, ["https://a.example"])).verified).toBe(true);
  });
});
