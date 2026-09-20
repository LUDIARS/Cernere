import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { verifyCloudflareAuthentication } from "../../src/enterprise/cloudflare-assertion.js";
import { resetEdgeJwksCache } from "../../src/auth/edge-jwks.js";
import type { EnterpriseConnection } from "../../src/enterprise/connections.js";

const now = 1800000000000;
const uuid = "12345678-1234-4234-8234-123456789012";
const connection: EnterpriseConnection = { projectKey: "demo", organizationId: uuid, oidcClientId: "test-client",
  teamDomain: "enterprise-test.cloudflareaccess.com", audience: "a".repeat(64), requireMfa: true,
  maxAuthenticationAge: 600, maxSessionSeconds: 600, isActive: true, revision: uuid, updatedAt: new Date(now) };
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const custom = { auth_time: now / 1000 - 10, amr: ["pwd", "otp", "mfa"], cr_auth_revision: 1,
  cr_connection_revision: uuid, cr_user_id: uuid };
const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ keys: [{
  ...pair.publicKey.export({ format: "jwk" }), kid: "test", use: "sig", alg: "RS256",
}] }));
function assertion(changes: Record<string, unknown> = {}): string {
  return jwt.sign({ iss: "https://" + connection.teamDomain, aud: [connection.audience], type: "app", sub: uuid,
    iat: now / 1000 - 5, exp: now / 1000 + 300, custom, ...changes }, pair.privateKey, { algorithm: "RS256", keyid: "test" });
}

describe("Cloudflare enterprise assertion boundary", () => {
  beforeEach(resetEdgeJwksCache);
  it("accepts signed, fresh MFA facts bound to the configured application", async () => {
    expect(await verifyCloudflareAuthentication(connection, assertion(), { now, fetchImpl })).toMatchObject({ userId: uuid, subject: uuid, authenticationRevision: 1 });
  });
  it.each([
    { aud: ["b".repeat(64)] }, { iss: "https://another.cloudflareaccess.com" }, { type: "service" },
    { custom: {} }, { custom: { ...custom, amr: ["pwd"] } },
    { custom: { ...custom, auth_time: now / 1000 - 601 } },
    { custom: { ...custom, cr_connection_revision: "changed" } },
    { custom: { ...custom, cr_user_id: undefined } }, { exp: now / 1000 - 1 },
  ])("rejects invalid trust, purpose, expiry and missing custom facts: %j", async (changes) => {
    await expect(verifyCloudflareAuthentication(connection, assertion(changes), { now, fetchImpl })).rejects.toThrow();
  });
  it("rejects a forged signature", async () => {
    const parts = assertion().split(".");
    parts[2] = "A".repeat(parts[2].length);
    await expect(verifyCloudflareAuthentication(connection, parts.join("."), { now, fetchImpl })).rejects.toThrow();
  });
  it("rejects stale signing keys when refreshing the JWKS fails", async () => {
    await verifyCloudflareAuthentication(connection, assertion(), { now, fetchImpl });
    const later = now + 7 * 3600000;
    const freshAssertion = assertion({ iat: later / 1000 - 5, exp: later / 1000 + 300,
      custom: { ...custom, auth_time: later / 1000 - 10 } });
    await expect(verifyCloudflareAuthentication(connection, freshAssertion, { now: later,
      fetchImpl: async () => { throw new Error("unavailable"); } })).rejects.toThrow();
  });
});
