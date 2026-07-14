/**
 * PASETO v4 (Ed25519 公開鍵署名) project-token
 *
 * 「あるユーザが、 ある project (Memoria Hub 等) に向けて発行する短命 token」
 * を Ed25519 で署名する。 service 側 (= Hub) は **public key のみ** を持ち、
 * 検証する。 HS256 共有 secret 時代の 「Hub 漏洩 = 偽造能力漏洩」 を解消。
 *
 * keypair の管理:
 *   - secret key: Cernere private (Infisical or env)
 *   - public key: GET /.well-known/cernere-public-key で公開、 service が 6h ごと fetch
 *
 * keypair の生成は scripts/generate-paseto-keypair.ts を 1 回手動実行する想定。
 * 生成後の base64 文字列を env に貼る。
 *
 * 鍵ローテーション (key rotation ceremony):
 *   署名鍵は CERNERE_PASETO_SECRET_KEY/_PUBLIC_KEY/_KID の 1 組のみ。 ただし
 *   旧鍵で署名された未失効 token を移行ウィンドウ中も検証できるよう、
 *   CERNERE_PASETO_PREVIOUS_PUBLIC_KEYS に「検証専用の旧 public key」を
 *   複数 (kid:base64 をカンマ区切り) 並べられる。 これらは getPublicKeys() でも
 *   公開されるため、 service 側は新旧どちらの token も検証できる。
 *   ローテーション手順:
 *     1. 新 keypair を生成し、 旧 public key を _PREVIOUS_ に追記
 *     2. _SECRET/_PUBLIC/_KID を新鍵に差し替えて Cernere 再起動 (新 token は新鍵で署名)
 *     3. 旧 token の TTL (15分) 経過後、 _PREVIOUS_ から旧 public key を削除
 *
 * spec / migration timeline: Cernere Issue #91 を参照。
 */

import { createPrivateKey, type KeyObject } from "node:crypto";
import { V4, type ConsumeOptions, type ProduceOptions } from "paseto";
import { devLog } from "../logging/dev-logger.js";

// Ed25519 PKCS8 ASN.1 prefix — 32 byte seed をこの後ろに連結すると
// `crypto.createPrivateKey({ format: 'der', type: 'pkcs8' })` で読める private KeyObject になる。
// paseto v3.1.4 の bytesToKeyObject (lib/v2/key.js) と同じ approach。
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** 32 byte の Ed25519 seed から private KeyObject を構築。 paseto V4.sign に
 *  渡す前段で必要 — raw 32 byte Buffer は public key と誤認される。 */
function seedToPrivateKey(seed: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

// ── claims ───────────────────────────────────────────────────────────────────

/** PASETO v4 で署名する project-token の claims。
 *  既存 HS256 (UserProjectJwtClaims) との差分: aud / displayName / kid。
 *  sub = userId をそのまま維持 → 既存 service 側 middleware が壊れない。
 *
 *  iat / exp は paseto v3.1.4 の規約で ISO 8601 日付文字列。 Unix epoch number を
 *  そのまま入れると verify 側で `payload.exp must be a string` で reject される。 */
export interface PasetoProjectClaims {
  sub: string;          // userId (UUID)
  projectKey: string;   // managed_projects.key (例: "memoria")
  role: string;         // users.role (例: "general" / "admin")
  displayName: string;  // users.display_name / login (PII 最小、 email は含めない)
  kind: "user_for_project";
  aud: string;          // 「この token を受ける service の URL」 (例: "https://hub.memoria.example.com")
  iat: string;          // ISO 8601 (paseto v3 規約)
  exp: string;          // ISO 8601
  jti?: string;         // replay 検出用 (= service 側で 1 回限り検証する用途)
}

// ── key 管理 ─────────────────────────────────────────────────────────────────

/** 検証専用 public key (署名鍵の現行 public + ローテーション中の旧 public)。 */
interface VerifyKey {
  kid: string;
  publicKey: Buffer;
  /** 現行署名鍵の public か (= 新規 token はこの kid で署名される)。 */
  current: boolean;
}

interface PasetoKeyset {
  /** 現行署名鍵。 新規 token はこれで署名する。
   *  signingKey は paseto V4.sign に渡す Node KeyObject (raw seed では
   *  ライブラリが public key と誤判定するため pre-build しておく)。 */
  signing: { kid: string; signingKey: KeyObject; publicKey: Buffer };
  /** 検証に使える全 public key (現行 + 旧)。 getPublicKeys() で公開される。 */
  verifyKeys: VerifyKey[];
}

/** "kid:base64" を 1 件パースする。 */
function parsePreviousKey(entry: string): { kid: string; publicKey: Buffer } {
  const idx = entry.indexOf(":");
  if (idx <= 0) {
    throw new Error(`invalid entry "${entry}" (expected "kid:base64")`);
  }
  const kid = entry.slice(0, idx).trim();
  const publicKey = Buffer.from(entry.slice(idx + 1).trim(), "base64");
  if (publicKey.length !== 32) {
    throw new Error(`previous key kid=${kid} length=${publicKey.length} (expected 32)`);
  }
  return { kid, publicKey };
}

/** 起動時 env から署名鍵 + 旧 public key を読み出す。
 *  署名鍵がなければ 「PASETO 機能無効化」 として例外を投げず undefined を返す
 *  (= HS256 のみで動作する legacy mode)。 */
function loadKeys(): PasetoKeyset | undefined {
  const secretB64 = process.env.CERNERE_PASETO_SECRET_KEY;
  const publicB64 = process.env.CERNERE_PASETO_PUBLIC_KEY;
  const kid = process.env.CERNERE_PASETO_KID ?? "v1";
  if (!secretB64 || !publicB64) {
    devLog("auth.paseto.disabled", { reason: "CERNERE_PASETO_SECRET_KEY or _PUBLIC_KEY not set" });
    return undefined;
  }
  try {
    const secret = Buffer.from(secretB64, "base64");
    const publicKey = Buffer.from(publicB64, "base64");
    // Ed25519 secret は 32 byte (seed) or 64 byte (seed || public)。 publicKey は raw 32 byte。
    let seed: Buffer;
    if (secret.length === 32) {
      seed = secret;
    } else if (secret.length === 64) {
      // 末尾 32 byte は public copy。 paseto lib の bytesToKeyObject と同じ前処理。
      seed = secret.subarray(0, 32);
    } else {
      throw new Error(`CERNERE_PASETO_SECRET_KEY length=${secret.length} (expected 32 or 64)`);
    }
    if (publicKey.length !== 32) {
      throw new Error(`CERNERE_PASETO_PUBLIC_KEY length=${publicKey.length} (expected 32)`);
    }

    // paseto V4.sign は KeyObject (Ed25519 private) しか受け付けない。 raw 32 byte
    // を渡すと paseto 内 _checkPrivateKey が public key と誤判定して失敗するため、
    // ここで PKCS8 + createPrivateKey を経由して KeyObject に昇格させる。
    const signingKey = seedToPrivateKey(seed);

    const verifyKeys: VerifyKey[] = [{ kid, publicKey, current: true }];

    // 旧 public key (検証専用、 ローテーション移行ウィンドウ用)。
    const previousRaw = process.env.CERNERE_PASETO_PREVIOUS_PUBLIC_KEYS;
    if (previousRaw) {
      for (const entry of previousRaw.split(",").map((e) => e.trim()).filter(Boolean)) {
        const prev = parsePreviousKey(entry);
        if (verifyKeys.some((k) => k.kid === prev.kid)) {
          throw new Error(`duplicate kid "${prev.kid}" in CERNERE_PASETO_PREVIOUS_PUBLIC_KEYS`);
        }
        verifyKeys.push({ kid: prev.kid, publicKey: prev.publicKey, current: false });
      }
    }

    return { signing: { kid, signingKey, publicKey }, verifyKeys };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`PASETO key load failed: ${msg}`);
  }
}

const keyset = loadKeys();

export function isPasetoEnabled(): boolean {
  return !!keyset;
}

/** 起動時に PASETO が使えるか warn しておく (= 初回起動でユーザが env を入れ忘れる事故防止)。 */
if (!keyset) {
  console.warn("[paseto] CERNERE_PASETO_SECRET_KEY/_PUBLIC_KEY not set — falling back to HS256 only");
} else {
  const prev = keyset.verifyKeys.filter((k) => !k.current).map((k) => k.kid);
  console.log(
    `[paseto] enabled (signing kid=${keyset.signing.kid}` +
      (prev.length > 0 ? `, previous=${prev.join(",")}` : "") +
      ")",
  );
}

/** /.well-known/cernere-public-key で返す key 一覧 (現行 + ローテーション中の旧鍵)。 */
export function getPublicKeys(): Array<{ kid: string; alg: "EdDSA"; public_key: string; current: boolean }> {
  if (!keyset) return [];
  return keyset.verifyKeys.map((k) => ({
    kid: k.kid,
    alg: "EdDSA",
    public_key: k.publicKey.toString("base64"),
    current: k.current,
  }));
}

// ── sign ─────────────────────────────────────────────────────────────────────

const PROJECT_TOKEN_TTL_SEC = 15 * 60;

/** project-token を PASETO v4 で署名する。 keys 未設定なら例外。 */
export async function signProjectToken(params: {
  userId: string;
  projectKey: string;
  role: string;
  displayName: string;
  audience: string;
  ttlSec?: number;
}): Promise<string> {
  if (!keyset) throw new Error("PASETO is not enabled (set CERNERE_PASETO_SECRET_KEY)");
  const nowMs = Date.now();
  const ttlSec = params.ttlSec ?? PROJECT_TOKEN_TTL_SEC;
  const claims: PasetoProjectClaims = {
    sub: params.userId,
    projectKey: params.projectKey,
    role: params.role,
    displayName: params.displayName,
    kind: "user_for_project",
    aud: params.audience,
    iat: new Date(nowMs).toISOString(),
    exp: new Date(nowMs + ttlSec * 1000).toISOString(),
    jti: crypto.randomUUID(),
  };
  const opts: ProduceOptions = { kid: keyset.signing.kid };
  // V4.sign は KeyObject (Ed25519 private) を要求する。 loadKeys() で
  // seedToPrivateKey() 経由で構築済み。 claims は index signature を持たない
  // 狭い型なので Record<string, unknown> 互換に cast する。
  return V4.sign(
    claims as unknown as Record<string, unknown>,
    keyset.signing.signingKey as unknown as Parameters<typeof V4.sign>[1],
    opts,
  );
}

// ── verify (= Cernere 内では使わないが、 unit test 用に export) ────────────────

/**
 * project-token を検証する。
 *
 * - `expectedAudience` は **必須**。 token の aud claim と一致しない場合は失敗する。
 *   audience を省略可能にすると 「service A 向けに発行した token を service B が
 *   そのまま受理する」 confused-deputy が起きるため、 呼び出し側に必ず自分の
 *   service URL を渡させる。
 * - ローテーション中は現行 + 旧 public key の全てを順に試し、 1 つでも検証に
 *   成功すればその claims を返す。
 */
export async function verifyProjectTokenPaseto(
  token: string,
  expectedAudience: string,
): Promise<PasetoProjectClaims> {
  if (!keyset) throw new Error("PASETO is not enabled");
  if (!expectedAudience) {
    throw new Error("expectedAudience is required for project-token verification");
  }
  const opts: ConsumeOptions<true> = { complete: true, audience: expectedAudience };

  let lastErr: unknown;
  for (const key of keyset.verifyKeys) {
    try {
      const result = await V4.verify(
        token,
        key.publicKey as unknown as Parameters<typeof V4.verify>[1],
        opts as unknown as ConsumeOptions<true>,
      );
      const payload = (result as { payload: unknown }).payload as PasetoProjectClaims;
      if (payload.kind !== "user_for_project") {
        throw new Error(`invalid token kind: ${payload.kind}`);
      }
      return payload;
    } catch (err) {
      lastErr = err;
      // 署名不一致の場合は次の (旧) 鍵を試す。 aud 不一致や期限切れも
      // 鍵ごとに同じ結果になるが、 ループ後に最後のエラーを投げる。
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`PASETO verification failed: ${msg}`);
}
