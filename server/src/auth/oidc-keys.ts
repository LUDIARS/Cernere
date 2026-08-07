/**
 * OIDC id_token 用 RSA 署名鍵 (RS256) の解決と JWKS 公開。
 *
 * 外部 RP は `jwks_uri` から公開鍵を取得して id_token を検証する。 RP 側の EdDSA
 * 対応が不確実なため、 相互運用性優先で RSA-2048 / RS256 を採用する。 project-token
 * 用の PASETO/Ed25519 鍵 (auth/paseto.ts) とは用途・鍵種別ともに別物。
 *
 * 鍵の解決順 (initialize()):
 *   1. `CERNERE_OIDC_MODE=off`  — OIDC を使わない構成。 鍵に一切触れず無効化する。
 *   2. `CERNERE_OIDC_PRIVATE_KEY` — env の PKCS8 PEM (raw or base64)。 kid は
 *      `CERNERE_OIDC_KID` (既定 "oidc-1")。 多重インスタンスで鍵を共有する場合はこちら。
 *   3. DB (`oidc_signing_keys`) の現行鍵。 無ければ生成して永続化するので、 env を
 *      置かなくても kid は再起動をまたいで安定する。
 *
 * 失敗時の扱い:
 *   - env に鍵を明示したのに読めない = 設定ミスなので throw して起動を止める。
 *   - DB の鍵ストアに到達できない (or CERNERE_SECRET_KEY 未設定) = 警告して無効化。
 *     OIDC を使わないデプロイを起動不能にしないため。 無効時は各エンドポイントが 503。
 *
 * 鍵ローテーション:
 *   旧鍵で署名した未失効 id_token (TTL = ID_TOKEN_TTL_SEC) を移行ウィンドウ中も RP が
 *   検証できるよう、 JWKS には現行鍵 + 検証専用の旧 public key を並べる。 旧鍵の供給元は
 *   2 つ: `oidc_signing_keys.retired_at` が TTL 以内の行と、 env
 *   `CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS` (`kid:base64(PEM)` のカンマ区切り)。
 *
 * 仕様: spec/feature/oidc-provider.md §1.1 / 手順は spec/setup/oidc-provider.md。
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
  type JsonWebKey,
} from "node:crypto";
import jwt from "jsonwebtoken";
import {
  oidcKeyRepository,
  type OidcKeyRepository,
  type OidcStoredSigningKey,
} from "./oidc-key-repository.js";
import { ID_TOKEN_TTL_SEC } from "../oidc/scopes.js";

interface OidcVerifyKey {
  kid: string;
  publicKey: KeyObject;
  current: boolean;
}

interface OidcKeyset {
  signing: { kid: string; privatePem: string };
  verifyKeys: OidcVerifyKey[];
  source: "env" | "db";
}

export interface OidcKeyManager {
  init(): Promise<void>;
  isEnabled(): boolean;
  kid(): string | undefined;
  jwks(): { keys: JsonWebKey[] };
  status(): OidcKeyStatus;
  sign(claims: Record<string, unknown>, expiresInSec: number): string;
}

export interface OidcKeyManagerOptions {
  repository: OidcKeyRepository;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** env の鍵を raw PEM または base64 PEM から正規化する。 */
function decodeKeyEnv(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("-----BEGIN")) return trimmed;
  return Buffer.from(trimmed, "base64").toString("utf-8");
}

export function parsePreviousPublicKey(entry: string): { kid: string; publicKey: KeyObject } {
  const idx = entry.indexOf(":");
  if (idx <= 0) {
    throw new Error(`invalid CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS entry "${entry}" (expected "kid:base64")`);
  }
  const kid = entry.slice(0, idx).trim();
  if (!kid) throw new Error(`empty kid in CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS entry "${entry}"`);
  const publicKey = createPublicKey({ key: decodeKeyEnv(entry.slice(idx + 1).trim()) });
  if (publicKey.asymmetricKeyType !== "rsa") {
    throw new Error(`CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS kid=${kid} must be an RSA public key (got ${publicKey.asymmetricKeyType ?? "unknown"})`);
  }
  return { kid, publicKey };
}

export function jwksFromVerifyKeys(
  keys: Array<{ kid: string; publicKey: KeyObject }>,
): { keys: JsonWebKey[] } {
  return {
    keys: keys.map((key) => ({
      ...key.publicKey.export({ format: "jwk" }),
      kid: key.kid,
      use: "sig",
      alg: "RS256",
    })),
  };
}

/**
 * JWKS に載せる public key は必ず署名に使う private key から導出する。
 * `public_key_pem` 列は (private と違って) 暗号化も改竄検知もされないので、
 * これを信用すると「署名に使っていない鍵」を検証鍵として公開しうる。
 */
function signingFromStoredKey(
  key: OidcStoredSigningKey,
): { kid: string; privatePem: string; publicKey: KeyObject } {
  const privateKey = createPrivateKey({ key: key.privateKeyPem });
  if (privateKey.asymmetricKeyType !== "rsa") {
    throw new Error(`OIDC signing key kid=${key.kid} must be RSA`);
  }
  return {
    kid: key.kid,
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: createPublicKey(privateKey),
  };
}

function generateStoredKey(): OidcStoredSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    kid: `oidc-${randomBytes(4).toString("hex")}`,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    isCurrent: true,
    createdAt: new Date(),
    retiredAt: null,
  };
}

function appendPreviousEnvKeys(verifyKeys: OidcVerifyKey[], environment: NodeJS.ProcessEnv): void {
  const previousRaw = environment.CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS;
  if (!previousRaw) return;
  const fromEnv = new Set<string>();
  for (const entry of previousRaw.split(",").map((value) => value.trim()).filter(Boolean)) {
    const previous = parsePreviousPublicKey(entry);
    // env 内での重複は設定ミスなので落とす。
    if (fromEnv.has(previous.kid)) {
      throw new Error(`duplicate kid "${previous.kid}" in CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS`);
    }
    fromEnv.add(previous.kid);
    // 現行鍵 / DB の retired 鍵と同じ kid はローテーション中に普通に起こる。
    // 設定ミスではないので起動を止めず、 既に公開済みの方を残す。
    if (verifyKeys.some((key) => key.kid === previous.kid)) {
      console.warn(`[oidc] ignoring CERNERE_OIDC_PREVIOUS_PUBLIC_KEYS kid=${previous.kid} (already published)`);
      continue;
    }
    verifyKeys.push({ ...previous, current: false });
  }
}

async function resolveDatabaseKey(repository: OidcKeyRepository): Promise<OidcStoredSigningKey> {
  const current = await repository.findCurrent();
  if (current) return current;

  const generated = generateStoredKey();
  try {
    await repository.insertCurrent(generated);
    return generated;
  } catch (error) {
    const concurrent = await repository.findCurrent();
    if (concurrent) return concurrent;
    throw error;
  }
}

export function createOidcKeyManager(options: OidcKeyManagerOptions): OidcKeyManager {
  const environment = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());
  let keyset: OidcKeyset | undefined;
  let initializing: Promise<void> | undefined;

  async function initialize(): Promise<void> {
    // OIDC は任意機能。 「鍵を使わない」 構成 (EducationLab のように Cernere 認証だけで
    // 完結するデプロイ) を明示できるようにし、 それを起動のブロック要因にしない
    // (neco 裁定 2026-08-04)。
    const mode = (environment.CERNERE_OIDC_MODE ?? "auto").trim().toLowerCase() || "auto";
    if (mode !== "auto" && mode !== "off") {
      throw new Error('CERNERE_OIDC_MODE must be "auto" or "off"');
    }
    if (mode === "off") {
      console.log("[oidc] disabled (CERNERE_OIDC_MODE=off)");
      return;
    }

    const raw = environment.CERNERE_OIDC_PRIVATE_KEY;
    let signing: { kid: string; privatePem: string; publicKey: KeyObject };
    let source: OidcKeyset["source"];
    let retired: OidcStoredSigningKey[] = [];

    if (raw) {
      const privateKey = createPrivateKey({ key: decodeKeyEnv(raw) });
      if (privateKey.asymmetricKeyType !== "rsa") {
        throw new Error(`CERNERE_OIDC_PRIVATE_KEY must be an RSA key (got ${privateKey.asymmetricKeyType ?? "unknown"})`);
      }
      signing = {
        kid: environment.CERNERE_OIDC_KID ?? "oidc-1",
        privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        publicKey: createPublicKey(privateKey),
      };
      source = "env";
    } else {
      try {
        const stored = await resolveDatabaseKey(options.repository);
        signing = signingFromStoredKey(stored);
        source = "db";
      } catch (error) {
        // 鍵ストアに到達できないだけで起動を止めない。 env で鍵を明示した場合の
        // 読み取り失敗は設定ミスなので throw するが (上の分岐)、 こちらは
        // 「OIDC を使わない」 に落とすのが正しい既定。
        console.warn(`[oidc] disabled — signing key unavailable: ${(error as Error).message}`);
        return;
      }

      // 旧鍵は JWKS の付加情報にすぎない。 現行鍵が取れている以上、 ここで失敗しても
      // OIDC ごと落とさず 「移行ウィンドウ中の旧 id_token だけ検証できない」 に留める。
      try {
        retired = await options.repository.findRetiredSince(
          new Date(now().getTime() - ID_TOKEN_TTL_SEC * 1000),
        );
      } catch (error) {
        console.warn(`[oidc] retired keys unavailable, publishing current key only: ${(error as Error).message}`);
      }
    }

    const verifyKeys: OidcVerifyKey[] = [
      { kid: signing.kid, publicKey: signing.publicKey, current: true },
    ];
    for (const retiredKey of retired) {
      if (verifyKeys.some((key) => key.kid === retiredKey.kid)) continue;
      let retiredPublicKey: KeyObject;
      try {
        // 現行鍵と同じく private から導出する (public_key_pem は信用しない)。
        retiredPublicKey = createPublicKey({ key: retiredKey.privateKeyPem });
        if (retiredPublicKey.asymmetricKeyType !== "rsa") {
          throw new Error(`not an RSA key (got ${retiredPublicKey.asymmetricKeyType ?? "unknown"})`);
        }
      } catch (error) {
        // 旧鍵 1 本が壊れているだけで OIDC ごと落とさない。 現行鍵での署名/検証は
        // そのまま成立し、 影響はその kid の id_token を検証できないことに留まる。
        console.warn(`[oidc] skipping retired key kid=${retiredKey.kid}: ${(error as Error).message}`);
        continue;
      }
      verifyKeys.push({ kid: retiredKey.kid, publicKey: retiredPublicKey, current: false });
    }
    appendPreviousEnvKeys(verifyKeys, environment);
    keyset = { signing, verifyKeys, source };
    const previous = verifyKeys.filter((key) => !key.current).map((key) => key.kid);
    const suffix = previous.length > 0 ? `, previous=${previous.join(",")}` : "";
    console.log(`[oidc] enabled (kid=${signing.kid}, source=${source}${suffix})`);
  }

  return {
    init(): Promise<void> {
      if (!initializing) initializing = initialize();
      return initializing;
    },
    isEnabled(): boolean {
      return !!keyset;
    },
    kid(): string | undefined {
      return keyset?.signing.kid;
    },
    jwks(): { keys: JsonWebKey[] } {
      return keyset ? jwksFromVerifyKeys(keyset.verifyKeys) : { keys: [] };
    },
    status(): OidcKeyStatus {
      if (!keyset) return { enabled: false, activeKid: null, keys: [] };
      return {
        enabled: true,
        activeKid: keyset.signing.kid,
        keys: keyset.verifyKeys.map((key) => ({ kid: key.kid, current: key.current })),
      };
    },
    sign(claims: Record<string, unknown>, expiresInSec: number): string {
      if (!keyset) throw new Error("OIDC is not initialized: initOidcKeys() が未実行です");
      return jwt.sign(claims, keyset.signing.privatePem, {
        algorithm: "RS256",
        keyid: keyset.signing.kid,
        expiresIn: expiresInSec,
      });
    },
  };
}

export interface OidcKeyStatus {
  enabled: boolean;
  activeKid: string | null;
  keys: Array<{ kid: string; current: boolean }>;
}

let defaultManager = createOidcKeyManager({ repository: oidcKeyRepository });
let defaultManagerInitialized = false;

/** 起動時に一度だけ呼ぶ。repository 引数は DB を張らない単体テスト用。 */
export function initOidcKeys(repository?: OidcKeyRepository): Promise<void> {
  if (repository && !defaultManagerInitialized) {
    defaultManager = createOidcKeyManager({ repository });
  }
  defaultManagerInitialized = true;
  return defaultManager.init();
}

export function isOidcEnabled(): boolean {
  return defaultManager.isEnabled();
}

export function oidcKid(): string | undefined {
  return defaultManager.kid();
}

export function getOidcJwks(): { keys: JsonWebKey[] } {
  return defaultManager.jwks();
}

export function getOidcKeyStatus(): OidcKeyStatus {
  return defaultManager.status();
}

export function signIdToken(claims: Record<string, unknown>, expiresInSec: number): string {
  return defaultManager.sign(claims, expiresInSec);
}
