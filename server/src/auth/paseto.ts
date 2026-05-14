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

import { V4, type ConsumeOptions, type ProduceOptions } from "paseto";
import { devLog } from "../logging/dev-logger.js";

// ── claims ───────────────────────────────────────────────────────────────────

/** PASETO v4 で署名する project-token の claims。
 *  既存 HS256 (UserProjectJwtClaims) との差分: aud / displayName / kid。
 *  sub = userId をそのまま維持 → 既存 service 側 middleware が壊れない。 */
export interface PasetoProjectClaims {
  sub: string;          // userId (UUID)
  projectKey: string;   // managed_projects.key (例: "memoria")
  role: string;         // users.role (例: "general" / "admin")
  displayName: string;  // users.display_name / login (PII 最小、 email は含めない)
  kind: "user_for_project";
  aud: string;          // 「この token を受ける service の URL」 (例: "https://hub.memoria.example.com")
  iat: number;
  exp: number;
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
  /** 現行署名鍵。 新規 token はこれで署名する。 */
  signing: { kid: string; secret: Buffer; publicKey: Buffer };
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
    // Ed25519 secret は 32 or 64 byte、 public は 32 byte
    if (secret.length !== 32 && secret.length !== 64) {
      throw new Error(`CERNERE_PASETO_SECRET_KEY length=${secret.length} (expected 32 or 64)`);
    }
    if (publicKey.length !== 32) {
      throw new Error(`CERNERE_PASETO_PUBLIC_KEY length=${publicKey.length} (expected 32)`);
    }

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

    return { signing: { kid, secret, publicKey }, verifyKeys };
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
  const now = Math.floor(Date.now() / 1000);
  const claims: PasetoProjectClaims = {
    sub: params.userId,
    projectKey: params.projectKey,
    role: params.role,
    displayName: params.displayName,
    kind: "user_for_project",
    aud: params.audience,
    iat: now,
    exp: now + (params.ttlSec ?? PROJECT_TOKEN_TTL_SEC),
    jti: crypto.randomUUID(),
  };
  const opts: ProduceOptions = { kid: keyset.signing.kid };
  // V4 secret key は 32 byte (seed) でも 64 byte (= seed + public concatenated) でも受け取る。
  // claims を Record<string, unknown> 互換に cast (PasetoProjectClaims は index signature を
  // 持たない狭い型なので、 ライブラリ I/F に合わせる)。
  return V4.sign(
    claims as unknown as Record<string, unknown>,
    keyset.signing.secret as unknown as Parameters<typeof V4.sign>[1],
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
