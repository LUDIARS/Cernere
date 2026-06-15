/**
 * OIDC id_token 署名鍵 (RSA / RS256) + JWKS 公開
 *
 * OpenID Connect Provider として発行する id_token は RS256 で署名する。
 * Cloudflare Access の generic OIDC をはじめ、 RP は `jwks_uri` から公開鍵を
 * 取得して署名検証する。 EdDSA (PASETO で使っている Ed25519) は RP 側の
 * 対応が不確実なため、 相互運用性を最優先して RSA-2048 / RS256 を採用する。
 *
 * project-token 用の PASETO 鍵 (auth/paseto.ts) とは用途・鍵種別ともに別物。
 * こちらは「外部 RP に配る OIDC id_token 専用」の鍵。
 *
 * 鍵の管理:
 *   - private key: env `CERNERE_OIDC_PRIVATE_KEY` (PKCS8 PEM、 raw PEM か base64)
 *   - kid:         env `CERNERE_OIDC_KID` (既定 "oidc-1")
 *   - public key:  private から導出し `GET /.well-known/jwks.json` で公開
 *
 * 鍵が未設定のとき:
 *   - development: 起動毎に ephemeral な RSA キーペアを生成 (再起動で失効)。
 *   - production:  OIDC Provider を無効化 (isOidcEnabled() === false)。
 *                  既存デプロイを鍵未設定で落とさないため、 throw はしない。
 *
 * 鍵生成 (本番用):
 *   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out oidc.pem
 *   CERNERE_OIDC_PRIVATE_KEY="$(base64 -w0 oidc.pem)" を Infisical / env に設定。
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  type JsonWebKey,
} from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

interface OidcKeyset {
  kid: string;
  /** jsonwebtoken の sign に渡す PKCS8 PEM 文字列。 */
  privatePem: string;
  publicKey: KeyObject;
}

/** env の鍵を PEM 文字列に正規化する。 raw PEM ならそのまま、 そうでなければ
 *  base64 とみなしてデコードする。 */
function decodeKeyEnv(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("-----BEGIN")) return trimmed;
  return Buffer.from(trimmed, "base64").toString("utf-8");
}

function loadKeyset(): OidcKeyset | undefined {
  const kid = process.env.CERNERE_OIDC_KID ?? "oidc-1";
  const raw = process.env.CERNERE_OIDC_PRIVATE_KEY;

  if (raw) {
    const pem = decodeKeyEnv(raw);
    const privateKey = createPrivateKey({ key: pem });
    if (privateKey.asymmetricKeyType !== "rsa") {
      throw new Error(
        `CERNERE_OIDC_PRIVATE_KEY must be an RSA key (got ${privateKey.asymmetricKeyType ?? "unknown"})`,
      );
    }
    const publicKey = createPublicKey(privateKey);
    const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    return { kid, privatePem, publicKey };
  }

  // 鍵未設定。 本番では無効化、 dev では ephemeral 生成。
  if (config.isProduction) return undefined;

  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { kid, privatePem, publicKey };
}

let keyset: OidcKeyset | undefined;
try {
  keyset = loadKeyset();
} catch (err) {
  // 鍵の指定があるのに読めない = 設定ミス。 黙って無効化すると気付けないので落とす。
  throw new Error(`OIDC key load failed: ${(err as Error).message}`);
}

if (!keyset) {
  console.warn(
    "[oidc] CERNERE_OIDC_PRIVATE_KEY not set in production — OIDC provider disabled",
  );
} else if (!process.env.CERNERE_OIDC_PRIVATE_KEY) {
  console.warn(
    `[oidc] using ephemeral RSA keypair (kid=${keyset.kid}) — set CERNERE_OIDC_PRIVATE_KEY to persist across restarts`,
  );
} else {
  console.log(`[oidc] enabled (kid=${keyset.kid})`);
}

export function isOidcEnabled(): boolean {
  return !!keyset;
}

export function oidcKid(): string | undefined {
  return keyset?.kid;
}

/** `GET /.well-known/jwks.json` のレスポンスボディ。 RP が id_token 検証に使う。 */
export function getOidcJwks(): { keys: JsonWebKey[] } {
  if (!keyset) return { keys: [] };
  const jwk = keyset.publicKey.export({ format: "jwk" });
  return {
    keys: [{ ...jwk, kid: keyset.kid, use: "sig", alg: "RS256" }],
  };
}

/**
 * id_token を RS256 で署名する。
 * `iat` / `exp` は jsonwebtoken が付与するので claims には含めない。
 */
export function signIdToken(claims: Record<string, unknown>, expiresInSec: number): string {
  if (!keyset) throw new Error("OIDC is not enabled (set CERNERE_OIDC_PRIVATE_KEY)");
  return jwt.sign(claims, keyset.privatePem, {
    algorithm: "RS256",
    keyid: keyset.kid,
    expiresIn: expiresInSec,
  });
}
