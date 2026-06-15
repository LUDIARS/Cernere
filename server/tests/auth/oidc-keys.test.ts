import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { createPublicKey, type JsonWebKey } from "node:crypto";
import { getOidcJwks, signIdToken, isOidcEnabled, oidcKid } from "../../src/auth/oidc-keys";

// テスト env (CERNERE_ENV=test, CERNERE_OIDC_PRIVATE_KEY 未設定) では
// ephemeral RSA キーペアが生成され OIDC は有効になる。

describe("oidc-keys", () => {
  it("is enabled with an ephemeral keypair", () => {
    expect(isOidcEnabled()).toBe(true);
    expect(oidcKid()).toBeTruthy();
  });

  it("exposes an RSA signing JWK", () => {
    const { keys } = getOidcJwks();
    expect(keys).toHaveLength(1);
    const jwk = keys[0] as Record<string, unknown>;
    expect(jwk.kty).toBe("RSA");
    expect(jwk.alg).toBe("RS256");
    expect(jwk.use).toBe("sig");
    expect(jwk.kid).toBe(oidcKid());
    expect(typeof jwk.n).toBe("string");
    expect(typeof jwk.e).toBe("string");
  });

  it("signs an id_token verifiable with the published JWK (RS256 roundtrip)", () => {
    const token = signIdToken({ sub: "u1", iss: "https://cernere.example", aud: "client-1" }, 3600);

    const header = jwt.decode(token, { complete: true })?.header;
    expect(header?.alg).toBe("RS256");
    expect(header?.kid).toBe(oidcKid());

    const { keys } = getOidcJwks();
    const publicKey = createPublicKey({ key: keys[0] as JsonWebKey, format: "jwk" });
    const payload = jwt.verify(token, publicKey, { algorithms: ["RS256"] }) as Record<string, unknown>;

    expect(payload.sub).toBe("u1");
    expect(payload.aud).toBe("client-1");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
  });
});
