import { generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  records: new Map<string, string>(), select: vi.fn(), issueCode: vi.fn(),
}));
vi.mock("../../src/db/connection.js", () => ({ db: { select: deps.select } }));
vi.mock("../../src/config.js", () => ({ config: { deviceSessionsEnabled: true, webauthnOrigins: ["https://cr.example"] } }));
vi.mock("../../src/auth/session-keys.js", () => ({ loadSessionKeyMaterial: () => ({ master: Buffer.alloc(32, 1) }) }));
vi.mock("../../src/auth/user-session-state.js", () => ({ currentUserSessionState: async () => ({ sub: "user", role: "general" }) }));
vi.mock("../../src/auth/auth-code.js", () => ({ issueAuthCodeForUserId: deps.issueCode }));
vi.mock("../../src/redis.js", () => ({
  checkRateLimit: vi.fn(), redis: {
    set: async (key: string, value: string) => deps.records.set(key, value),
    getdel: async (key: string) => { const v = deps.records.get(key); deps.records.delete(key); return v ?? null; },
  },
}));
import { compositeDeviceProof } from "../../src/auth/composite-device-proof.js";

const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
const ctx = { deviceIp: "192.0.2.8", origin: "https://cr.example" };
const binding = { audience: "service" as const, projectKey: "glab", origin: "https://glab.example", codeChallenge: "a".repeat(43) };
const body = { deviceId: "efe8642d-2db2-44c7-924a-6af8eaf64b78", target: binding.origin, state: "s".repeat(32), targetMode: "post_message" };
const row = { id: body.deviceId, userId: "user", authEpoch: 1, proofPublicKey: publicKey,
  authentication: { authTime: 1, authTimeMs: 1000, amr: ["pop", "mfa"], revision: 1 }, expiresAt: new Date(Date.now() + 60_000) };

async function signedRequest() {
  const result = await compositeDeviceProof("begin", body, ctx, binding);
  if (!("challenge" in result)) throw new Error("missing challenge");
  const signature = sign("sha256", Buffer.from(result.challenge), { key: pair.privateKey, dsaEncoding: "ieee-p1363" });
  return { ...body, ...result, signature: signature.toString("base64url") };
}

describe("registered browser device proof", () => {
  beforeEach(() => {
    deps.records.clear();
    deps.issueCode.mockReset().mockResolvedValue("code");
    deps.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [row] }) }) });
  });
  it("hands a single-use signature to the ordinary service consent and revocation gate", async () => {
    const request = await signedRequest();
    await expect(compositeDeviceProof("finish", request, ctx, binding)).resolves.toEqual({ authCode: "code" });
    expect(deps.issueCode).toHaveBeenCalledWith("user", expect.objectContaining({ authCodeBinding: binding }),
      expect.objectContaining({ deviceId: body.deviceId, authentication: row.authentication }));
    await expect(compositeDeviceProof("finish", request, ctx, binding)).rejects.toThrow();
  });
  it("rejects a changed source IP, destination or state", async () => {
    await expect(compositeDeviceProof("finish", await signedRequest(), { ...ctx, deviceIp: "192.0.2.9" }, binding)).rejects.toThrow();
    await expect(compositeDeviceProof("finish", await signedRequest(), ctx, { ...binding, codeChallenge: "b".repeat(43) })).rejects.toThrow();
    await expect(compositeDeviceProof("finish", { ...await signedRequest(), state: "x".repeat(32) }, ctx, binding)).rejects.toThrow();
    expect(deps.issueCode).not.toHaveBeenCalled();
  });
  it("needs the registered private key even with the original device ID and IP", async () => {
    const request = await signedRequest();
    await expect(compositeDeviceProof("finish", { ...request, signature: "A".repeat(86) }, ctx, binding)).rejects.toThrow();
    expect(deps.issueCode).not.toHaveBeenCalled();
  });
});
