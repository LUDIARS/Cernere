import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";

// paseto.ts は import 時に CERNERE_PASETO_* を読むため、鍵を注入してから動的 import する。
type ServiceTokenModule = typeof import("../../src/auth/service-token");
type PasetoModule = typeof import("../../src/auth/paseto");
let serviceToken: ServiceTokenModule;
let paseto: PasetoModule;

beforeAll(async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  process.env.CERNERE_PASETO_SECRET_KEY = pkcs8.subarray(pkcs8.length - 32).toString("base64");
  process.env.CERNERE_PASETO_PUBLIC_KEY = spki.subarray(spki.length - 32).toString("base64");
  process.env.CERNERE_PASETO_KID = "test";
  paseto = await import("../../src/auth/paseto");
  serviceToken = await import("../../src/auth/service-token");
});

describe("auth/service-token — service 文脈の PASETO", () => {
  it("sub / aud / scope を載せて user 版と同じ鍵で検証できる", async () => {
    const token = await serviceToken.signServiceToken({
      subject: "volputas", audience: "glab", scopes: ["review-relay:write"],
    });
    const claims = await serviceToken.verifyServiceTokenPaseto(token, "glab");
    expect(claims).toMatchObject({ kind: "service", sub: "volputas", aud: "glab", scope: ["review-relay:write"] });
    expect(serviceToken.hasServiceScope(claims, "review-relay:write")).toBe(true);
    expect(serviceToken.hasServiceScope(claims, "persona-export:read")).toBe(false);
    expect(Date.parse(claims.exp) - Date.parse(claims.iat)).toBe(serviceToken.SERVICE_TOKEN_TTL_SEC * 1000);
  });

  it("別の aud 向け token は受理しない (confused deputy)", async () => {
    const token = await serviceToken.signServiceToken({ subject: "volputas", audience: "glab", scopes: ["a:b"] });
    await expect(serviceToken.verifyServiceTokenPaseto(token, "calliope")).rejects.toThrow();
  });

  it("user 版 token と service 版 token を取り違えない", async () => {
    const userToken = await paseto.signProjectToken({
      userId: "user-1", projectKey: "glab", role: "general", displayName: "A", audience: "glab",
    });
    await expect(serviceToken.verifyServiceTokenPaseto(userToken, "glab")).rejects.toThrow(/invalid token kind/);

    const svcToken = await serviceToken.signServiceToken({ subject: "volputas", audience: "glab", scopes: ["a:b"] });
    await expect(paseto.verifyProjectTokenPaseto(svcToken, "glab")).rejects.toThrow(/invalid token kind/);
  });

  it("期限切れ token は拒否する", async () => {
    const token = await serviceToken.signServiceToken({
      subject: "volputas", audience: "glab", scopes: ["a:b"], ttlSec: -60,
    });
    await expect(serviceToken.verifyServiceTokenPaseto(token, "glab")).rejects.toThrow();
  });
});
