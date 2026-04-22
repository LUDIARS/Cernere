/**
 * JWKS (RFC 7517) を Cernere から取得して cache し、project token を
 * ローカル検証するためのユーティリティ.
 *
 * Cernere side は `managed_project.get_jwks` WS コマンドで JWKS を返す
 * (/Cernere/server/src/ws/project-dispatch.ts 参照). このキャッシュは
 * プロセス起動時に一度 fetch し、kid mismatch 時に lazy re-fetch する.
 */

import { createPublicKey, createVerify, type KeyObject } from "node:crypto";

export interface Jwk {
  kty: "RSA";
  use: "sig";
  alg: "RS256";
  kid: string;
  n:   string;
  e:   string;
}

export interface JwksDocument {
  keys: Jwk[];
}

export interface VerifiedProjectClaims {
  sub:        string;         // clientId
  projectKey: string;
  tokenType:  "project";
  iat:        number;
  exp:        number;
}

export class JwksCache {
  private byKid = new Map<string, KeyObject>();
  private lastRefreshAt = 0;

  constructor(
    /** JWKS を取得する関数. Cernere WS で `managed_project.get_jwks` を呼ぶ実装を渡す. */
    private readonly fetcher: () => Promise<JwksDocument>,
    /** 最低再取得間隔 (ms). この間隔内で kid miss が連続しても Cernere を叩き続けない. */
    private readonly minRefreshIntervalMs = 5_000,
  ) {}

  /** Cernere から JWKS を取得して cache に反映. */
  async refresh(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefreshAt < this.minRefreshIntervalMs) return;
    this.lastRefreshAt = now;
    const doc = await this.fetcher();
    this.byKid.clear();
    for (const jwk of doc.keys) {
      if (jwk.kty !== "RSA" || jwk.alg !== "RS256") continue;
      const keyObj = createPublicKey({
        key:    jwk as unknown as import("node:crypto").JsonWebKey,
        format: "jwk",
      });
      this.byKid.set(jwk.kid, keyObj);
    }
  }

  /** kid から公開鍵を取得. 無ければ null. */
  get(kid: string): KeyObject | undefined {
    return this.byKid.get(kid);
  }

  /**
   * 与えられた project JWT を検証し、claims を返す.
   * 署名不一致 / 期限切れ / kid 未解決は throw.
   * kid miss 時は一度だけ refresh を試みて再判定.
   */
  async verifyProjectToken(token: string): Promise<VerifiedProjectClaims> {
    const parsed = parseJwt(token);
    if (!parsed) throw new JwksVerifyError("malformed_jwt", "malformed JWT");
    if (parsed.header.alg !== "RS256") {
      throw new JwksVerifyError("bad_alg", `unexpected alg ${parsed.header.alg}`);
    }
    const kid = parsed.header.kid;
    if (!kid) throw new JwksVerifyError("missing_kid", "kid header required");

    let pubkey = this.get(kid);
    if (!pubkey) {
      await this.refresh();
      pubkey = this.get(kid);
    }
    if (!pubkey) throw new JwksVerifyError("unknown_kid", `unknown kid "${kid}"`);

    // RS256 = RSASSA-PKCS1-v1_5 + SHA-256 over "${header}.${payload}".
    const [headerB64, payloadB64, sigB64] = token.split(".");
    if (!headerB64 || !payloadB64 || !sigB64) {
      throw new JwksVerifyError("malformed_jwt", "3 parts required");
    }
    const signingInput = `${headerB64}.${payloadB64}`;
    const sigBuf = Buffer.from(sigB64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signingInput);
    verifier.end();
    const ok = verifier.verify(pubkey, sigBuf);
    if (!ok) throw new JwksVerifyError("bad_signature", "signature verification failed");

    const claims = parsed.payload;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp === "number" && claims.exp < now) {
      throw new JwksVerifyError("expired", "token expired");
    }
    if (claims.tokenType !== "project") {
      throw new JwksVerifyError("wrong_type", "not a project token");
    }
    if (typeof claims.sub !== "string" || typeof claims.projectKey !== "string") {
      throw new JwksVerifyError("malformed_claims", "claims missing sub/projectKey");
    }
    return {
      sub:        claims.sub,
      projectKey: claims.projectKey,
      tokenType:  "project",
      iat:        typeof claims.iat === "number" ? claims.iat : now,
      exp:        typeof claims.exp === "number" ? claims.exp : now + 3600,
    };
  }
}

export class JwksVerifyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "JwksVerifyError";
  }
}

// ── 内部 ──────────────────────────────────────

interface ParsedJwt {
  header: { alg: string; typ?: string; kid?: string };
  payload: Record<string, unknown>;
  signature: string;
}

function parseJwt(token: string): ParsedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header  = JSON.parse(b64urlDecode(parts[0]!));
    const payload = JSON.parse(b64urlDecode(parts[1]!));
    return { header, payload, signature: parts[2]! };
  } catch {
    return null;
  }
}

function b64urlDecode(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
