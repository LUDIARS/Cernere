/**
 * Project token 用の非対称鍵 (RSA-2048).
 *
 * Phase 0a (service adapter foundation): Cernere が発行する project token は
 * 他 LUDIARS サービスが **ローカルで** 検証できる必要がある. user token で
 * 使っている HS256 (symmetric) だと、検証鍵を共有した時点で第三者が任意の
 * token を偽造できるため、project token 専用に RS256 の鍵ペアを設ける.
 *
 * 運用:
 *   - 本番: `CERNERE_PROJECT_SIGNING_KEY` に PEM 形式の秘密鍵を入れる.
 *          公開鍵は秘密鍵から導出するので別途設定不要.
 *   - 開発: 鍵が設定されていなければ起動時に ephemeral な鍵ペアを生成し
 *          warn ログを出す. プロセス再起動で鍵が変わり、先発行の token は
 *          一斉に無効化される. dev 用途では問題にならない.
 *
 * 公開鍵は `managed_project.get_jwks` WS コマンド (`ws/project-dispatch.ts`)
 * で RFC 7517 JWKS 形式で公開される. service adapter 側はそれを cache
 * して受信トークンの検証に使う.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

export interface ProjectSigningKeys {
  privateKey: KeyObject;
  publicKey:  KeyObject;
  /** Key ID: 公開鍵 DER の sha256 先頭 16 バイト (hex). ローテ時に変わる. */
  kid: string;
}

let cached: ProjectSigningKeys | null = null;

/** 初回呼び出しで鍵を読み込みまたは生成し、以降は cache を返す. */
export function getProjectSigningKeys(): ProjectSigningKeys {
  if (cached) return cached;
  cached = loadOrGenerate();
  return cached;
}

function loadOrGenerate(): ProjectSigningKeys {
  const pem = process.env.CERNERE_PROJECT_SIGNING_KEY?.trim();
  if (pem && pem.length > 0) {
    return fromPem(pem);
  }
  if (process.env.CERNERE_ENV === "production" || process.env.APP_ENV === "production") {
    throw new Error(
      "CERNERE_PROJECT_SIGNING_KEY must be set in production " +
      "(PEM-encoded RSA-2048 private key). Generate one with: " +
      "openssl genrsa -out project_signing.pem 2048",
    );
  }
  console.warn(
    "[project-keys] CERNERE_PROJECT_SIGNING_KEY not set — generating an " +
    "ephemeral RSA key pair. Project tokens issued now will be invalid after " +
    "the next restart. Set the env var before any staging deployment.",
  );
  return generateEphemeral();
}

function fromPem(pem: string): ProjectSigningKeys {
  const privateKey = createPrivateKey({ key: pem, format: "pem" });
  const publicKey  = createPublicKey(privateKey);
  return { privateKey, publicKey, kid: computeKid(publicKey) };
}

function generateEphemeral(): ProjectSigningKeys {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return { privateKey, publicKey, kid: computeKid(publicKey) };
}

function computeKid(pk: KeyObject): string {
  const der = pk.export({ format: "der", type: "spki" }) as Buffer;
  return createHash("sha256").update(der).digest("hex").slice(0, 32);
}

/**
 * RFC 7517 JWKS 形式で公開鍵を返す. service adapter が
 * `managed_project.get_jwks` で取得してキャッシュする.
 */
export function getProjectJwks(): { keys: JwkRsaPublic[] } {
  const { publicKey, kid } = getProjectSigningKeys();
  const jwk = publicKey.export({ format: "jwk" }) as {
    kty: "RSA";
    n:   string;
    e:   string;
  };
  return {
    keys: [
      {
        kty: "RSA",
        use: "sig",
        alg: "RS256",
        kid,
        n:   jwk.n,
        e:   jwk.e,
      },
    ],
  };
}

export interface JwkRsaPublic {
  kty: "RSA";
  use: "sig";
  alg: "RS256";
  kid: string;
  n:   string;
  e:   string;
}

/** テスト専用: cache を破棄して次回再読み込みさせる. */
export function __resetProjectKeysForTest(): void {
  cached = null;
}
