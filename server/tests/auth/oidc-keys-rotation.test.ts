import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { createPublicKey, generateKeyPairSync, type JsonWebKey } from "node:crypto";
import { parsePreviousPublicKey, jwksFromVerifyKeys } from "../../src/auth/oidc-keys";

// 鍵ローテーション (CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS) のパース + JWKS 合成は
// import 時 env に依存しない純粋関数として切り出してあるので、 ここでは
// 明示的な鍵を渡して直接検証する (= module シングルトンの env に依存しない)。

function genRsa() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKey, publicKey };
}

/** RSA public key を "kid:base64(PEM)" エントリ文字列にする。 */
function toEnvEntry(kid: string, publicKey: ReturnType<typeof genRsa>["publicKey"]): string {
  const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
  return `${kid}:${Buffer.from(pem, "utf-8").toString("base64")}`;
}

describe("oidc-keys rotation", () => {
  it("parses a kid:base64(PEM) previous-key entry into an RSA public key", () => {
    const { publicKey } = genRsa();
    const parsed = parsePreviousPublicKey(toEnvEntry("oidc-prev", publicKey));
    expect(parsed.kid).toBe("oidc-prev");
    expect(parsed.publicKey.asymmetricKeyType).toBe("rsa");
  });

  it("accepts raw PEM (un-base64'd) in the value part too", () => {
    const { publicKey } = genRsa();
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const parsed = parsePreviousPublicKey(`raw-kid:${pem}`);
    expect(parsed.kid).toBe("raw-kid");
    expect(parsed.publicKey.asymmetricKeyType).toBe("rsa");
  });

  it("rejects malformed entries and non-RSA keys", () => {
    expect(() => parsePreviousPublicKey("no-colon-value")).toThrow();
    expect(() => parsePreviousPublicKey(":onlyvalue")).toThrow();
    const { publicKey: ed } = generateKeyPairSync("ed25519");
    const pem = ed.export({ format: "pem", type: "spki" }).toString();
    expect(() => parsePreviousPublicKey(`ed:${Buffer.from(pem).toString("base64")}`)).toThrow(/RSA/);
  });

  it("publishes current + previous keys in the JWKS, each with its own kid", () => {
    const current = genRsa();
    const previous = genRsa();
    const { keys } = jwksFromVerifyKeys([
      { kid: "oidc-2", publicKey: current.publicKey },
      { kid: "oidc-1", publicKey: previous.publicKey },
    ]);

    expect(keys).toHaveLength(2);
    expect(keys.map((k) => (k as Record<string, unknown>).kid)).toEqual(["oidc-2", "oidc-1"]);
    for (const jwk of keys as Record<string, unknown>[]) {
      expect(jwk.kty).toBe("RSA");
      expect(jwk.alg).toBe("RS256");
      expect(jwk.use).toBe("sig");
    }
  });

  it("lets an RP verify a token signed by the current key during the rotation window", () => {
    const current = genRsa();
    const previous = genRsa();
    const { keys } = jwksFromVerifyKeys([
      { kid: "oidc-2", publicKey: current.publicKey },
      { kid: "oidc-1", publicKey: previous.publicKey },
    ]);

    // 現行鍵 (oidc-2) で署名。
    const token = jwt.sign({ sub: "u1" }, current.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), {
      algorithm: "RS256",
      keyid: "oidc-2",
      expiresIn: 3600,
    });

    // RP は JWKS の中から header.kid に一致する公開鍵を選んで検証する。
    const header = jwt.decode(token, { complete: true })?.header;
    const jwk = (keys as Record<string, unknown>[]).find((k) => k.kid === header?.kid);
    expect(jwk).toBeDefined();
    const publicKey = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
    const payload = jwt.verify(token, publicKey, { algorithms: ["RS256"] }) as Record<string, unknown>;
    expect(payload.sub).toBe("u1");

    // 旧鍵 (oidc-1) でも、 その kid に対応する公開鍵で過去発行の token を検証できる。
    const oldToken = jwt.sign({ sub: "u0" }, previous.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), {
      algorithm: "RS256",
      keyid: "oidc-1",
      expiresIn: 3600,
    });
    const oldHeader = jwt.decode(oldToken, { complete: true })?.header;
    const oldJwk = (keys as Record<string, unknown>[]).find((k) => k.kid === oldHeader?.kid);
    const oldPub = createPublicKey({ key: oldJwk as JsonWebKey, format: "jwk" });
    expect((jwt.verify(oldToken, oldPub, { algorithms: ["RS256"] }) as Record<string, unknown>).sub).toBe("u0");
  });
});
