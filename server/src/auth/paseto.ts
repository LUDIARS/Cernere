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
 * spec / migration timeline: Cernere Issue #91 を参照。
 */

import { V4, type ConsumeOptions, type ProduceOptions } from "paseto";
import { config } from "../config.js";
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

/** 起動時 env から secret / public key を読み出す。
 *  なければ 「PASETO 機能無効化」 として例外を投げず undefined を返す
 *  (= HS256 のみで動作する legacy mode)。 */
function loadKeys(): { secret: Buffer; publicKey: Buffer; kid: string } | undefined {
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
    return { secret, publicKey, kid };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`PASETO key load failed: ${msg}`);
  }
}

const keys = loadKeys();

export function isPasetoEnabled(): boolean {
  return !!keys;
}

/** 起動時に PASETO が使えるか warn しておく (= 初回起動でユーザが env を入れ忘れる事故防止)。 */
if (!keys) {
  console.warn("[paseto] CERNERE_PASETO_SECRET_KEY/_PUBLIC_KEY not set — falling back to HS256 only");
} else {
  console.log(`[paseto] enabled (kid=${keys.kid})`);
}

/** /.well-known/cernere-public-key で返す key 一覧。 */
export function getPublicKeys(): Array<{ kid: string; alg: "EdDSA"; public_key: string }> {
  if (!keys) return [];
  return [{ kid: keys.kid, alg: "EdDSA", public_key: keys.publicKey.toString("base64") }];
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
  if (!keys) throw new Error("PASETO is not enabled (set CERNERE_PASETO_SECRET_KEY)");
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
  const opts: ProduceOptions = { kid: keys.kid };
  // V4 secret key は 32 byte (seed) でも 64 byte (= seed + public concatenated) でも受け取る。
  // claims を Record<string, unknown> 互換に cast (PasetoProjectClaims は index signature を
  // 持たない狭い型なので、 ライブラリ I/F に合わせる)。
  return V4.sign(
    claims as unknown as Record<string, unknown>,
    keys.secret as unknown as Parameters<typeof V4.sign>[1],
    opts,
  );
}

// ── verify (= Cernere 内では使わないが、 unit test 用に export) ────────────────

export async function verifyProjectTokenPaseto(
  token: string,
  expectedAudience?: string,
): Promise<PasetoProjectClaims> {
  if (!keys) throw new Error("PASETO is not enabled");
  const opts: ConsumeOptions<true> = { complete: true, audience: expectedAudience };
  const result = await V4.verify(
    token,
    keys.publicKey as unknown as Parameters<typeof V4.verify>[1],
    opts as unknown as ConsumeOptions<true>,
  );
  const payload = (result as { payload: unknown }).payload as PasetoProjectClaims;
  if (payload.kind !== "user_for_project") {
    throw new Error(`invalid token kind: ${payload.kind}`);
  }
  return payload;
}
