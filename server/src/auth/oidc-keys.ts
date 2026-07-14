/**
 * OIDC id_token 署名鍵 (RSA / RS256) + JWKS 公開 + 鍵ローテーション
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
 *
 * 鍵ローテーション (key rotation、 PASETO の _PREVIOUS_PUBLIC_KEYS と同方式):
 *   署名鍵は CERNERE_OIDC_PRIVATE_KEY/_KID の 1 組のみ。 ただし旧鍵で署名した
 *   未失効 id_token (TTL 1h) を移行ウィンドウ中も RP が検証できるよう、
 *   CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS に「検証専用の旧 public key」を複数
 *   (`kid:base64` をカンマ区切り) 並べられる。 これらは getOidcJwks() で
 *   現行鍵と一緒に公開されるため、 RP は新旧どちらの id_token も検証できる。
 *   手順:
 *     1. 新 RSA 鍵を生成し、 旧鍵の public を _PREVIOUS_PUBLIC_KEYS に追記。
 *     2. _PRIVATE_KEY/_KID を新鍵に差し替えて Cernere 再起動 (新 token は新鍵署名)。
 *     3. 旧 id_token の TTL (ID_TOKEN_TTL_SEC) + JWKS キャッシュ経過後、
 *        _PREVIOUS_PUBLIC_KEYS から旧 public key を削除。
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

/** 検証に使える public key 1 件 (現行署名鍵の public、 または旧鍵)。 */
interface OidcVerifyKey {
  kid: string;
  publicKey: KeyObject;
  /** 現行署名鍵の public か (= 新規 id_token はこの kid で署名される)。 */
  current: boolean;
}

interface OidcKeyset {
  /** 現行署名鍵。 新規 id_token はこれで署名する。 */
  signing: {
    kid: string;
    /** jsonwebtoken の sign に渡す PKCS8 PEM 文字列。 */
    privatePem: string;
  };
  /** JWKS で公開する全 public key (現行 + ローテーション中の旧鍵)。 */
  verifyKeys: OidcVerifyKey[];
}

/** env の鍵を PEM 文字列に正規化する。 raw PEM ならそのまま、 そうでなければ
 *  base64 とみなしてデコードする。 */
function decodeKeyEnv(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("-----BEGIN")) return trimmed;
  return Buffer.from(trimmed, "base64").toString("utf-8");
}

/**
 * `CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS` の 1 エントリ "kid:base64(PEM)" をパースする。
 * 値部は raw PEM (base64 デコード後に `-----BEGIN`) でも、 そのまま PEM でも良い。
 * 検証専用なので RSA public key のみを受け付ける。
 */
export function parsePreviousPublicKey(entry: string): { kid: string; publicKey: KeyObject } {
  const idx = entry.indexOf(":");
  if (idx <= 0) {
    throw new Error(`invalid CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS entry "${entry}" (expected "kid:base64")`);
  }
  const kid = entry.slice(0, idx).trim();
  if (!kid) throw new Error(`empty kid in CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS entry "${entry}"`);
  const pem = decodeKeyEnv(entry.slice(idx + 1).trim());
  const publicKey = createPublicKey({ key: pem });
  if (publicKey.asymmetricKeyType !== "rsa") {
    throw new Error(
      `CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS kid=${kid} must be an RSA public key (got ${publicKey.asymmetricKeyType ?? "unknown"})`,
    );
  }
  return { kid, publicKey };
}

/** 検証鍵リストを JWKS レスポンス (RP が id_token 検証に使う) に変換する純粋関数。 */
export function jwksFromVerifyKeys(keys: Array<{ kid: string; publicKey: KeyObject }>): { keys: JsonWebKey[] } {
  return {
    keys: keys.map((k) => {
      const jwk = k.publicKey.export({ format: "jwk" });
      return { ...jwk, kid: k.kid, use: "sig", alg: "RS256" };
    }),
  };
}

function loadKeyset(): OidcKeyset | undefined {
  const kid = process.env.CERNERE_OIDC_KID ?? "oidc-1";
  const raw = process.env.CERNERE_OIDC_PRIVATE_KEY;

  let signing: OidcKeyset["signing"];
  let currentPublic: KeyObject;

  if (raw) {
    const pem = decodeKeyEnv(raw);
    const privateKey = createPrivateKey({ key: pem });
    if (privateKey.asymmetricKeyType !== "rsa") {
      throw new Error(
        `CERNERE_OIDC_PRIVATE_KEY must be an RSA key (got ${privateKey.asymmetricKeyType ?? "unknown"})`,
      );
    }
    currentPublic = createPublicKey(privateKey);
    signing = { kid, privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
  } else {
    // 鍵未設定。 本番では無効化、 dev では ephemeral 生成。
    if (config.isProduction) return undefined;
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    currentPublic = publicKey;
    signing = { kid, privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
  }

  const verifyKeys: OidcVerifyKey[] = [{ kid, publicKey: currentPublic, current: true }];

  // 旧 public key (検証専用、 ローテーション移行ウィンドウ用)。
  const previousRaw = process.env.CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS;
  if (previousRaw) {
    for (const entry of previousRaw.split(",").map((e) => e.trim()).filter(Boolean)) {
      const prev = parsePreviousPublicKey(entry);
      if (verifyKeys.some((k) => k.kid === prev.kid)) {
        throw new Error(`duplicate kid "${prev.kid}" in CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS`);
      }
      verifyKeys.push({ kid: prev.kid, publicKey: prev.publicKey, current: false });
    }
  }

  return { signing, verifyKeys };
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
} else {
  const previous = keyset.verifyKeys.filter((k) => !k.current).map((k) => k.kid);
  const suffix = previous.length > 0 ? `, previous=${previous.join(",")}` : "";
  if (!process.env.CERNERE_OIDC_PRIVATE_KEY) {
    console.warn(
      `[oidc] using ephemeral RSA keypair (kid=${keyset.signing.kid}${suffix}) — set CERNERE_OIDC_PRIVATE_KEY to persist across restarts`,
    );
  } else {
    console.log(`[oidc] enabled (kid=${keyset.signing.kid}${suffix})`);
  }
}

export function isOidcEnabled(): boolean {
  return !!keyset;
}

export function oidcKid(): string | undefined {
  return keyset?.signing.kid;
}

/** `GET /.well-known/jwks.json` のレスポンスボディ。 RP が id_token 検証に使う。
 *  現行鍵 + ローテーション中の旧鍵を全て返す。 */
export function getOidcJwks(): { keys: JsonWebKey[] } {
  if (!keyset) return { keys: [] };
  return jwksFromVerifyKeys(keyset.verifyKeys);
}

/** admin GUI / 運用向けの鍵ステータス (秘密情報は含まない)。 */
export interface OidcKeyStatus {
  enabled: boolean;
  /** 新規 id_token を署名している現行 kid。 無効時は null。 */
  activeKid: string | null;
  /** JWKS で公開している全 kid (現行 + ローテーション中の旧鍵)。 */
  keys: Array<{ kid: string; current: boolean }>;
}

export function getOidcKeyStatus(): OidcKeyStatus {
  if (!keyset) return { enabled: false, activeKid: null, keys: [] };
  return {
    enabled: true,
    activeKid: keyset.signing.kid,
    keys: keyset.verifyKeys.map((k) => ({ kid: k.kid, current: k.current })),
  };
}

/**
 * id_token を RS256 で署名する。
 * `iat` / `exp` は jsonwebtoken が付与するので claims には含めない。
 */
export function signIdToken(claims: Record<string, unknown>, expiresInSec: number): string {
  if (!keyset) throw new Error("OIDC is not enabled (set CERNERE_OIDC_PRIVATE_KEY)");
  return jwt.sign(claims, keyset.signing.privatePem, {
    algorithm: "RS256",
    keyid: keyset.signing.kid,
    expiresIn: expiresInSec,
  });
}
